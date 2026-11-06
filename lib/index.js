/**
 * dsh-rest 宿主端（Node 半区）。
 *
 * 职责：
 *   1. 按可配置间隔计时，到点记一次提醒（seq 自增）；
 *   2. 通过 /api/dsh-rest/* 路由把状态与设置交给浏览器端；
 *   3. 按设置决定是否在宿主端补一条系统通知（Windows 用 PowerShell，macOS 用 osascript，
 *      页面没开时也能提醒）。
 *
 * 设计约束：只用 Node 内置模块。
 *   profile 用 `link:` 安装时不会安装被链接包的 dependencies，
 *   因此这里**不能**依赖 @deepseek-ai/schemastery 等 dsh 内部包，
 *   否则整行导入失败、浏览器端也一起起不来。
 *   设置因此改为插件自己存 JSON，不占用 dsh 的 settings 服务。
 *
 * @module dsh-rest
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 包名：同时用作单实例挂载的键。 */
const PACKAGE_NAME = 'dsh-rest'

/** 能投递桌面通知的平台。 */
const SUPPORTED_NOTIFY_PLATFORMS = ['win32', 'darwin', 'linux']

/** 路由前缀。浏览器端以文档相对路径 `api/dsh-rest/...` 访问。 */
const API_PREFIX = '/api/dsh-rest'

/** 客户端心跳超过这个时长没有更新，视为页面已关闭。 */
const PAGE_OPEN_WINDOW_MS = 75_000

/** setTimeout 的安全上限（约 24.8 天，仅作保险）。 */
const MAX_TIMER_DELAY_MS = 2_147_000_000

/** 设置文件：放在 dsh home 下，和插件无关的会话数据分开。 */
const SETTINGS_FILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-rest.json')

/** 默认设置。 */
const DEFAULTS = Object.freeze({
  enabled: true,
  intervalMinutes: 30,
  /** dsh 内提示：off 关闭 / silent 只弹卡片 / sound 卡片 + 提示音。 */
  inAppMode: 'sound',
  systemNotification: 'whenPageClosed',
  message: '该休息一下了：起身走走，看看远处，喝口水。',
})

const SYSTEM_NOTIFICATION_MODES = ['off', 'whenPageClosed', 'always']

const IN_APP_MODES = ['off', 'silent', 'sound']

/**
 * 把旧版的两个布尔字段（inAppReminder / inAppSound）合成新的三档枚举。
 * 新字段缺席时才会走这里，因此老配置文件无需手工迁移。
 * @returns 折算出的 inAppMode。
 */
function legacyInAppMode(source, base) {
  if (typeof source.inAppReminder !== 'boolean') return base.inAppMode
  if (source.inAppReminder === false) return 'off'
  return source.inAppSound === false ? 'silent' : 'sound'
}

/** 把任意输入夹成合法设置；非法字段回落到兜底值。 */
function normalize(input, fallback) {
  const base = fallback ?? DEFAULTS
  const source = typeof input === 'object' && input !== null ? input : {}
  const interval = Number(source.intervalMinutes)
  const mode = source.systemNotification
  const message = typeof source.message === 'string' ? source.message.slice(0, 200) : base.message
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : base.enabled,
    intervalMinutes: Number.isFinite(interval) ? Math.min(720, Math.max(1, Math.round(interval))) : base.intervalMinutes,
    inAppMode: IN_APP_MODES.includes(source.inAppMode)
      ? source.inAppMode
      // 兼容旧配置：拆开的两个布尔字段合成新枚举。
      : legacyInAppMode(source, base),
    systemNotification: SYSTEM_NOTIFICATION_MODES.includes(mode) ? mode : base.systemNotification,
    message: message.trim() === '' ? base.message : message,
  }
}

// ---------------------------------------------------------------------------
// Windows Toast
// ---------------------------------------------------------------------------

/**
 * Toast 的应用归属标识（AppUserModelId）。
 *
 * 用 PowerShell 自己的 AUMID：它是系统内置、已注册的标识，通知**保证能弹出**。
 *
 * 试过应用自己的 `electron.app.DeepSeek Harness`：给它在注册表写 DisplayName 后
 * 通知仍有 98 条只进通知中心、不弹横幅 —— 该 AUMID 没有配套的开始菜单快捷方式，
 * Windows 不认可，静默降级。而补快捷方式要动开始菜单与注册表，按用户要求不做。
 *
 * 因此改用下面的内置 AUMID，并把「DeepSeek Harness」写进通知正文首行，
 * 让用户一眼能认出这条提醒来自哪里。
 */
const TOAST_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

/** 通知正文首行显示的应用名。 */
const TOAST_APP_NAME = 'DeepSeek Harness'

/**
 * PowerShell 生成脚本：用 ToastGeneric 模板投递一条通知。
 *
 * 只投递，不写注册表、不建快捷方式。
 */
function toastScript(titleB64, bodyB64) {
  return `
$ErrorActionPreference = 'Stop'
$title = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${titleB64}'))
$body  = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${bodyB64}'))
$appName = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(TOAST_APP_NAME, 'utf8').toString('base64')}'))
$appId = '${TOAST_APP_ID}'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$esc = { param($s) [System.Security.SecurityElement]::Escape($s) }
# 首行放应用名，第二行标题，第三行正文：通知弹出来就能看出是谁发的。
$xmlText = '<toast duration="long"><visual><binding template="ToastGeneric">' +
  '<text>' + (& $esc $appName) + '</text>' +
  '<text>' + (& $esc $title) + '</text>' +
  '<text>' + (& $esc $body) + '</text>' +
  '</binding></visual><audio src="ms-winsoundevent:Notification.Reminder"/></toast>'
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($xmlText)
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
`
}

/** 上一次 toast 投递的结局，供 /remind 与 /state 暴露给界面诊断。 */
let lastToastResult = { at: 0, ok: null, detail: null }

/** PowerShell 可执行文件的绝对路径；绕过 PATH 里可能的同名拦截。 */
const POWERSHELL_EXE = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)

/**
 * macOS 通知脚本：用 osascript 调用 AppleScript 弹一条通知中心横幅。
 *
 * 用 `display notification` 是最直接的渠道 —— 不需要额外的可执行文件，
 * 通知归属 osascript（与 Windows 侧归属 PowerShell 的情形对应），
 * 在没有签名的第三方脚本环境下这是唯一可靠的路径。
 * @param titleB64 - 标题的 base64（UTF-8）。
 * @param bodyB64 - 正文的 base64（UTF-8）。
 * @returns AppleScript 源码。
 */
function macNotificationScript(titleB64, bodyB64) {
  // base64 只含 A-Z a-z 0-9 + / =，放进 AppleScript 字符串字面量无需转义。
  return [
    'use AppleScript version "2.4"',
    'use framework "Foundation"',
    `set titleData to current application's NSData's alloc()'s initWithBase64EncodedString:"${titleB64}" options:0`,
    'set titleText to current application\'s NSString\'s alloc()\'s initWithData:titleData encoding:(current application\'s NSUTF8StringEncoding)',
    `set bodyData to current application's NSData's alloc()'s initWithBase64EncodedString:"${bodyB64}" options:0`,
    'set bodyText to current application\'s NSString\'s alloc()\'s initWithData:bodyData encoding:(current application\'s NSUTF8StringEncoding)',
    'display notification (bodyText as text) with title (titleText as text)',
  ].join('\n')
}

/**
 * 用给定命令投递通知，并把结局写进 lastToastResult。
 *
 * 三个平台的实现结构一致（起一个子进程、等它退出），差异只在命令行本身，
 * 所以共用这一个执行器，避免三份重复的错误处理。
 * @param file - 可执行文件绝对路径。
 * @param args - 命令行参数。
 * @param label - 日志里标识来源的名字。
 * @returns 投递结局 `{ ok, detail }`。
 */
function runNotifier(file, args, label) {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        {
          timeout: 15_000,
          windowsHide: true,
          // 清掉 Electron 注入的变量，让通知工具以常规方式启动。
          env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
        },
        (error, stdout, stderr) => {
          if (error) {
            const detail = describeFailure(error, stdout, stderr)
            console.warn(`[${PACKAGE_NAME}] ${label} 发送失败：`, detail)
            lastToastResult = { at: Date.now(), ok: false, detail }
            resolve(lastToastResult)
            return
          }
          lastToastResult = { at: Date.now(), ok: true, detail: 'sent' }
          resolve(lastToastResult)
        },
      )
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.warn(`[${PACKAGE_NAME}] ${label} 发送异常：`, detail)
      lastToastResult = { at: Date.now(), ok: false, detail }
      resolve(lastToastResult)
    }
  })
}

/** 单个通知的展示时长（毫秒）。 */
const NOTIFY_EXPIRE_MS = 15_000

/**
 * 投递一条系统通知并等它执行完。按平台分发：
 *   - win32：PowerShell + WinRT Toast；
 *   - darwin：osascript（通知中心横幅）；
 *   - linux：notify-send（libnotify，需桌面会话）；
 *   - 其他：不支持，直接返回失败。
 * @param title - 通知标题。
 * @param body - 通知正文。
 * @returns 投递结局 `{ ok, detail }`。
 */
function sendToast(title, body) {
  if (process.platform === 'win32') return sendWindowsToast(title, body)
  if (process.platform === 'darwin') return sendMacNotification(title, body)
  if (process.platform === 'linux') return sendLinuxNotification(title, body)
  lastToastResult = { at: Date.now(), ok: false, detail: 'unsupported-platform:' + process.platform }
  return Promise.resolve(lastToastResult)
}

/**
 * 从 execFile 的错误里尽量拼出有用的诊断信息。
 * @param error - execFile 抛出的错误。
 * @param stdout - 标准输出。
 * @param stderr - 标准错误。
 * @returns 一行可读的失败原因。
 */
function describeFailure(error, stdout, stderr) {
  const parts = []
  if (error.code !== undefined) parts.push('code=' + String(error.code))
  if (error.exitCode !== undefined) parts.push('exit=' + String(error.exitCode))
  if (error.killed === true) parts.push('killed=true')
  if (error.signal !== undefined) parts.push('signal=' + String(error.signal))
  const errText = (stderr || '').toString().trim()
  if (errText !== '') parts.push('stderr=' + errText.slice(0, 300))
  const outText = (stdout || '').toString().trim()
  if (outText !== '') parts.push('stdout=' + outText.slice(0, 200))
  return parts.length > 0 ? parts.join(' | ') : error.message || 'unknown'
}

/**
 * Windows：PowerShell + WinRT Toast，等执行完。
 * @returns 投递结局 `{ ok, detail }`。
 */
function sendWindowsToast(title, body) {
  const script = toastScript(
    Buffer.from(title, 'utf8').toString('base64'),
    Buffer.from(body, 'utf8').toString('base64'),
  )
  // 必须用 -Command，不能用 -EncodedCommand：
  // 实测同样一段 WinRT 代码走 -EncodedCommand 时进程静默退出（退出码 0、
  // 无输出），Toast 从未真正投递 —— 这正是"宿主说成功但看不到通知"的原因。
  // 用绝对路径：宿主进程的 PATH 可能被 Electron 改写。
  return runNotifier(
    POWERSHELL_EXE,
    ['-NoProfile', '-NonInteractive', '-Command', script],
    '系统通知',
  )
}

/**
 * macOS：osascript + AppleScript `display notification`，等执行完。
 * @returns 投递结局 `{ ok, detail }`。
 */
function sendMacNotification(title, body) {
  const script = macNotificationScript(
    Buffer.from(title, 'utf8').toString('base64'),
    Buffer.from(body, 'utf8').toString('base64'),
  )
  return runNotifier('/usr/bin/osascript', ['-e', script], '系统通知')
}

/**
 * 找 notify-send 的可执行文件：优先已知绝对路径，退回裸名交给 PATH。
 * @returns 可执行文件路径。
 */
function linuxNotifyCommand() {
  for (const candidate of ['/usr/bin/notify-send', '/bin/notify-send', '/usr/local/bin/notify-send']) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // 读不到就试下一个
    }
  }
  return 'notify-send'
}

/**
 * Linux：notify-send（libnotify），等执行完。
 *
 * 依赖桌面会话：`notify-send` 通过 D-Bus 找通知守护进程，纯终端/无桌面的
 * 环境（或经 ssh 进入的会话）会失败，此时返回的 detail 会写明原因。
 * 参数直接传，不经 shell —— 中文与引号都无需转义。
 *
 * 可执行文件按常见安装位置优先取绝对路径：宿主进程的 PATH 可能被改写，
 * 相对名解析不到。都找不到就用裸名，失败信息里会带 code=ENOENT。
 * @returns 投递结局 `{ ok, detail }`。
 */
function sendLinuxNotification(title, body) {
  return runNotifier(
    linuxNotifyCommand(),
    [
      '--app-name=' + TOAST_APP_NAME,
      '--expire-time=' + String(NOTIFY_EXPIRE_MS),
      '--urgency=normal',
      title,
      body,
    ],
    '系统通知',
  )
}

/**
 * 投递一条系统通知，不等待结果（计时器路径用）。
 * @param title - 通知标题。
 * @param body - 通知正文。
 */
function showWindowsToast(title, body) {
  void sendToast(title, body)
}

// ---------------------------------------------------------------------------
// HTTP 辅助
// ---------------------------------------------------------------------------

function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

/** 只接受本机回环请求：这个插件的接口不该被隧道 / 局域网客户端触达。 */
function isLoopback(req) {
  const address = (req.socket?.remoteAddress ?? '').toLowerCase()
  const loopback = address === '::1'
    || address.startsWith('::ffff:127.')
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address)
  if (!loopback) return false
  return req.headers['sec-fetch-site'] !== 'cross-site'
}

/** 读取有上限的 JSON 请求体；空体或非法 JSON 读成空对象。 */
async function readJson(req, maxBytes = 8 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) {
      req.destroy()
      return {}
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return {}
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** 读设置文件；文件缺失时返回 null（由调用方决定回落到什么）。 */
async function loadSettings() {
  try {
    const text = await readFile(SETTINGS_FILE, 'utf8')
    return normalize(JSON.parse(text))
  } catch {
    return null
  }
}

/** 写设置文件；父目录按需创建。 */
async function saveSettings(value) {
  const payload = JSON.stringify(value, null, 2) + '\n'
  await mkdir(dirname(SETTINGS_FILE), { recursive: true })
  await writeFile(SETTINGS_FILE, payload, 'utf8')
}

// ---------------------------------------------------------------------------
// 单实例守卫
// ---------------------------------------------------------------------------

const MOUNTED = Symbol.for('dsh-rest.mounted')

function claimMount() {
  if (globalThis[MOUNTED] === true) return false
  globalThis[MOUNTED] = true
  return true
}

function releaseMount() {
  globalThis[MOUNTED] = false
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

/**
 * Host 插件体。
 * @param ctx - cordis 根上下文。
 * @param config - profile 行给出的初始配置（可选，优先于文件但会被文件覆盖）。
 */
export const apply = (ctx, config) => {
  if (!claimMount()) {
    console.warn(`[${PACKAGE_NAME}] 已有一份实例在运行，跳过重复挂载。`)
    return
  }

  const disposers = []
  let timer = null
  let disposed = false
  /** 当前这次计时用的间隔（分钟）；设置里改了间隔才重新对表。 */
  let scheduledInterval = null
  /** 生效中的设置；启动后异步从文件覆盖。 */
  let settings = normalize(config, DEFAULTS)

  const state = {
    seq: 0,
    firedAt: null,
    nextAt: null,
    lastClientSeenAt: 0,
    /** 页面自己上报的可见性：true 可见、false 最小化/后台、null 未知。 */
    clientVisible: null,
    // 支持桌面通知的平台：Windows / macOS / Linux（Linux 需桌面会话）。
    toastSupported: SUPPORTED_NOTIFY_PLATFORMS.includes(process.platform),
  }

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  /**
   * 页面是否"看得见"：
   *   1. 页面上报过可见性（Page Visibility API + rAF 停走判定）就以它为准 ——
   *      最小化、后台、完全被遮挡都会报 hidden，这是最准的信号；
   *   2. 没有上报（老版本客户端/刚启动）时退回心跳新鲜度。
   * @returns 页面当前是否对用户可见。
   */
  const pageVisible = () => {
    if (state.clientVisible === false) return false
    return Date.now() - state.lastClientSeenAt < PAGE_OPEN_WINDOW_MS
  }

  /** 排下一次提醒。 */
  const scheduleNext = (delayMs, intervalMinutes) => {
    clearTimer()
    if (disposed) return
    if (!settings.enabled) {
      scheduledInterval = null
      state.nextAt = null
      return
    }
    const delay = Math.min(Math.max(0, delayMs), MAX_TIMER_DELAY_MS)
    scheduledInterval = intervalMinutes
    state.nextAt = Date.now() + delay
    timer = setTimeout(onTimer, delay)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  /** 以当前时刻为起点重新计时。 */
  const restart = () => {
    scheduleNext(settings.intervalMinutes * 60_000, settings.intervalMinutes)
  }

  /**
   * 触发一次提醒。
   *
   * 系统通知的三种模式：
   *   - off：任何情况都不发；
   *   - whenPageClosed：页面不可见才发 —— 最小化、被其他窗口完全遮挡、
   *     或页面已关闭（进程还在后台跑）都属于这一类；
   *   - always：每次都发。
   *
   * 可见性在"到点这一刻"现算，而不是沿用上一轮心跳的结论：
   * 最小化瞬间 rAF 需要几秒才停走，等到点时已经稳定。
   *
   * 结束后按设定间隔重排下一次 —— 手动触发与自然到点走的是同一条路径。
   */
  const fire = () => {
    if (!settings.enabled || disposed) return
    const now = Date.now()
    state.seq += 1
    state.firedAt = now
    const pageOpen = pageVisible()
    const wantToast = settings.systemNotification === 'always'
      || (settings.systemNotification === 'whenPageClosed' && !pageOpen)
    if (wantToast) showWindowsToast('该休息了', settings.message)
    scheduleNext(settings.intervalMinutes * 60_000, settings.intervalMinutes)
  }

  /**
   * 把倒计时清零：立刻按"到点"处理，然后重新开始计一轮。
   *
   * 与 fire() 的唯一区别是不做时钟回拨保护 —— 这是用户主动要求立即触发。
   * @returns 本次触发的系统通知结局，供界面回报。
   */
  const fireNow = () => {
    if (!settings.enabled || disposed) {
      return { fired: false, reason: settings.enabled ? 'disposed' : 'disabled' }
    }
    clearTimer()
    state.nextAt = null
    const now = Date.now()
    state.seq += 1
    state.firedAt = now
    const pageOpen = pageVisible()
    const wantToast = settings.systemNotification === 'always'
      || (settings.systemNotification === 'whenPageClosed' && !pageOpen)
    let toast = null
    if (wantToast) toast = sendToast('该休息了', settings.message)
    scheduleNext(settings.intervalMinutes * 60_000, settings.intervalMinutes)
    return { fired: true, pageOpen, wantToast, toast }
  }

  const onTimer = () => {
    timer = null
    if (!settings.enabled || disposed) return
    const now = Date.now()
    // 时钟回拨或提前唤醒：重新对表，不误报。
    if (state.nextAt !== null && now < state.nextAt - 1_000) {
      scheduleNext(state.nextAt - now, scheduledInterval)
      return
    }
    fire()
  }

  /** 设置变更后重排：只有"间隔"改了才重新对表。 */
  const rearm = () => {
    if (!settings.enabled) {
      clearTimer()
      scheduledInterval = null
      state.nextAt = null
      return
    }
    if (state.nextAt === null || scheduledInterval !== settings.intervalMinutes) restart()
  }

  /** 交给浏览器端的状态快照。 */
  const view = () => {
    const now = Date.now()
    return {
      seq: state.seq,
      firedAt: state.firedAt,
      nextAt: state.nextAt,
      intervalMinutes: settings.intervalMinutes,
      enabled: settings.enabled,
      inAppMode: settings.inAppMode,
      systemNotification: settings.systemNotification,
      toastSupported: state.toastSupported,
      /** 最近一次 Toast 的投递结局，供设置页显示诊断信息。 */
      lastToast: lastToastResult,
      pageOpen: pageVisible(),
      message: settings.message,
    }
  }

  /**
   * 包一条路由：回环围栏 + 方法校验 + 异常兜底。
   * @param method 允许的方法；'ANY' 表示同时接受 GET 与 POST。
   */
  const route = (method, path, handler) => ({
    kind: 'exact',
    path: `${API_PREFIX}${path}`,
    handler: async (req, res) => {
      if (!isLoopback(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      const actual = req.method ?? 'GET'
      const allowed = method === 'ANY' ? ['GET', 'POST'] : [method]
      if (!allowed.includes(actual)) {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      try {
        await handler(req, res)
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  const applySettings = async (patch) => {
    settings = normalize({ ...settings, ...patch }, settings)
    try {
      await saveSettings(settings)
    } catch (error) {
      console.warn(`[${PACKAGE_NAME}] 设置保存失败：`, error)
    }
    rearm()
    return settings
  }

  const routes = [
    route('GET', '/state', async (req, res) => {
      // 每次读状态都算一次心跳，用来判断 dsh 页面是否还在。
      state.lastClientSeenAt = Date.now()
      // 页面同时上报自己的可见性（最小化 / 后台标签页都会是 hidden）。
      const flag = new URL(req.url ?? '/', 'http://localhost').searchParams.get('visible')
      if (flag === '1') state.clientVisible = true
      else if (flag === '0') state.clientVisible = false
      writeJson(res, 200, view())
    }),
    // 同一路径的读与写合成一条路由，避免 exact 匹配只命中第一条。
    route('ANY', '/config', async (req, res) => {
      state.lastClientSeenAt = Date.now()
      if ((req.method ?? 'GET') === 'GET') {
        writeJson(res, 200, settings)
        return
      }
      const body = await readJson(req)
      const next = await applySettings(body)
      writeJson(res, 200, { ok: true, config: next })
    }),
    route('POST', '/remind', async (req, res) => {
      // 「立即提醒」= 把倒计时清零，走与自然到点完全相同的路径：
      // 同样的可见性判定、同样的 systemNotification 三档规则、同样重排下一轮。
      // 不是绕过判定的测试通道。
      state.lastClientSeenAt = Date.now()
      const outcome = fireNow()
      // 等投递结束再回包，让界面能立刻知道成功还是失败。
      const toast = outcome.toast === null || outcome.toast === undefined ? null : await outcome.toast
      writeJson(res, 200, {
        ok: true,
        fired: outcome.fired === true,
        reason: outcome.reason ?? null,
        toastSupported: state.toastSupported,
        /** systemNotification 为 off 时没有投递动作。 */
        skipped: toast === null && outcome.fired === true ? 'off' : null,
        toast,
        ...view(),
      })
    }),
  ]

  ctx.effect(() => {
    for (const definition of routes) {
      disposers.push(ctx.webServer.register(definition))
    }
    // 设置文件异步载入；到达后按文件值重排（文件优先于 profile 配置）。
    // 设置文件优先；文件不存在时保留 apply 收到的配置（profile 行 config）。
    loadSettings().then((loaded) => {
      if (disposed) return
      if (loaded !== null) settings = loaded
      restart()
    }, () => {
      if (!disposed) restart()
    })
    restart()
    return () => {
      disposed = true
      clearTimer()
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // 关停阶段路由 fiber 可能已经没了
        }
      }
      releaseMount()
    }
  }, `${PACKAGE_NAME}: runtime`)
}

export const name = PACKAGE_NAME
export const inject = ['webServer']
