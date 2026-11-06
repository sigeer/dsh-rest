/**
 * dsh-rest 浏览器端（web 半区）。
 *
 * 轮询宿主端状态；seq 增长即表示宿主端判定"该休息了"，此时：
 *   - 在页面右下角弹一张 dsh 内提示卡（可手动关闭，60 秒后自动消失）；
 *   - 播一声短提示音；
 *   - 若浏览器通知已获授权，发一条系统通知。
 *
 * 系统级通知由宿主端按设置发送（Windows 用 PowerShell，macOS 用 osascript），
 * 页面没开时也能提醒。
 *
 * 只依赖平台基线模块 react，不引入任何 dsh 内部 UI 包。
 * @module dsh-rest/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-rest',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')

    var h = react.createElement
    var useState = react.useState
    var useEffect = react.useEffect
    var useCallback = react.useCallback

    /** 文档相对路径：GUI 以 `<base href="./">` 提供，子路径部署也能解析。 */
    var API_BASE = 'api/dsh-rest'

    /** 轮询周期：足够及时发现提醒，又不至于打扰宿主。 */
    var POLL_INTERVAL_MS = 15_000

    /** 请求超时。 */
    var REQUEST_TIMEOUT_MS = 10_000

    /** 提示卡无人操作时的自动消失时长。 */
    var NOTICE_AUTO_DISMISS_MS = 60_000

    /** 提示卡容器的稳定标识，避免重复挂载。 */
    var HOST_SELECTOR = '[data-dsh-rest-card]'

    /**
     * requestAnimationFrame 是否已停止。
     *
     * true 表示窗口最小化或完全被遮挡（合成器不再出帧）。最小化时浏览器会
     * 冻结 rAF，回调永远不会再来；窗口恢复后由 visibilitychange / focus
     * 重新启动探测环。
     */
    var rafSuspended = false

    /** 最近一次 rAF 心跳的时间；超过阈值视为已停止。 */
    var rafLastTickAt = Date.now()

    /** rAF 判定为"停止"的阈值。 */
    var RAF_STALE_MS = 3000

    /** 探测环的句柄。 */
    var rafHandle = null

    function endpoint(name) {
      try {
        return new URL(API_BASE + '/' + name, document.baseURI).toString()
      } catch {
        return API_BASE + '/' + name
      }
    }

    /**
     * 页面是否"真的在用户眼前"。
     *
     * 只信 `document.visibilityState` 不够：Electron 里窗口最小化、被其他窗口
     * 完全遮挡、或整个 UI 跑在 webview/WebContentsView 里时，它经常仍报
     * visible。因此再用两条硬信号交叉判定：
     *
     *   1. visibilityState 明确为 hidden → 不可见（最直接）；
     *   2. requestAnimationFrame 已经停止 → 不可见（窗口最小化或完全被遮挡时，
     *      合成器不再出帧，这是浏览器无法伪装的信号）。
     *
     * @returns 页面当前是否对用户可见。
     */
    function isPageVisible() {
      if (documentHidden()) return false
      if (rafStalled()) return false
      return true
    }

    /** visibilityState 是否明确为 hidden；取不到时当作"没意见"。 */
    function documentHidden() {
      try {
        return document.visibilityState === 'hidden'
      } catch {
        return false
      }
    }

    /**
     * 启动 rAF 探测环：每帧记录一次时间戳。
     *
     * 页面最小化时 rAF 会完全停止，时间戳不再前进，于是 `isPageVisible()`
     * 通过 `rafLastTickAt` 的陈旧程度判定"不可见"。窗口恢复后 rAF 自动继续，
     * 无需额外重启；这里只负责在句柄丢失时重新挂上。
     */
    function startRafProbe() {
      if (rafHandle !== null) return
      var frame = window.requestAnimationFrame
      if (typeof frame !== 'function') return
      var tick = function () {
        rafLastTickAt = Date.now()
        rafSuspended = false
        rafHandle = frame(tick)
      }
      rafHandle = frame(tick)
    }

    /** 停掉 rAF 探测环。 */
    function stopRafProbe() {
      var cancel = window.cancelAnimationFrame
      if (rafHandle !== null && typeof cancel === 'function') {
        try {
          cancel(rafHandle)
        } catch {
          // 已失效
        }
      }
      rafHandle = null
    }

    /**
     * 判定 rAF 是否已停止。窗口恢复后 rAF 会自己继续，但时间戳需要一次推进
     * 才能变"新鲜"，所以这里只做读取，不做重启。
     * @returns rAF 是否已停止（= 窗口最小化或完全被遮挡）。
     */
    function rafStalled() {
      if (rafHandle === null) return false
      var stalled = Date.now() - rafLastTickAt > RAF_STALE_MS
      if (stalled !== rafSuspended) rafSuspended = stalled
      return stalled
    }

    async function fetchState() {
      // 把可见性随心跳一起上报：宿主端据此决定要不要补发系统通知。
      var url = endpoint('state') + '?visible=' + (isPageVisible() ? '1' : '0')
      var response = await fetch(url, {
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error('dsh-rest state failed: ' + response.status)
      return response.json()
    }

    async function post(name, body) {
      var response = await fetch(endpoint(name), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error('dsh-rest ' + name + ' failed: ' + response.status)
      return response.json()
    }

    // ------------------------------------------------------------------
    // 提示音
    // ------------------------------------------------------------------

    /**
     * 播一声两音短提示音。音频上下文被浏览器自动播放策略挡住时静默降级。
     */
    function playChime() {
      try {
        var AudioCtx = window.AudioContext || window.webkitAudioContext
        if (AudioCtx === undefined) return
        var context = new AudioCtx()
        var start = context.currentTime
        var notes = [
          { at: 0, freq: 660 },
          { at: 0.18, freq: 880 },
        ]
        for (var i = 0; i < notes.length; i++) {
          var note = notes[i]
          var osc = context.createOscillator()
          var gain = context.createGain()
          osc.type = 'sine'
          osc.frequency.value = note.freq
          gain.gain.setValueAtTime(0.0001, start + note.at)
          gain.gain.exponentialRampToValueAtTime(0.18, start + note.at + 0.02)
          gain.gain.exponentialRampToValueAtTime(0.0001, start + note.at + 0.35)
          osc.connect(gain)
          gain.connect(context.destination)
          osc.start(start + note.at)
          osc.stop(start + note.at + 0.4)
        }
        window.setTimeout(function () {
          try {
            context.close()
          } catch {
            // 已关闭
          }
        }, 1200)
      } catch (error) {
        console.warn('[dsh-rest] 提示音播放失败', error)
      }
    }

    // ------------------------------------------------------------------
    // 提示卡
    // ------------------------------------------------------------------

    var CARD_STYLE = {
      position: 'fixed',
      right: '24px',
      bottom: '24px',
      zIndex: '2147483000',
      width: '320px',
      boxSizing: 'border-box',
      padding: '16px 18px',
      borderRadius: '12px',
      background: '#ffffff',
      color: '#1f2328',
      border: '1px solid rgba(0,0,0,0.08)',
      boxShadow: '0 12px 32px rgba(0,0,0,0.18)',
      font: '14px/1.55 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
    }

    var TITLE_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      margin: '0 0 8px',
      fontSize: '15px',
      fontWeight: '600',
    }

    var BODY_STYLE = {
      margin: '0 0 14px',
      color: '#4a5058',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    }

    var ROW_STYLE = {
      display: 'flex',
      gap: '8px',
      justifyContent: 'flex-end',
      flexWrap: 'wrap',
    }

    function buttonStyle(primary) {
      return {
        padding: '7px 14px',
        borderRadius: '8px',
        border: primary ? '1px solid #2f6feb' : '1px solid rgba(0,0,0,0.14)',
        background: primary ? '#2f6feb' : '#ffffff',
        color: primary ? '#ffffff' : '#1f2328',
        font: 'inherit',
        cursor: 'pointer',
      }
    }

    /**
     * 提示卡组件。countdown 为下一次提醒的剩余秒数（≤0 时显示"即将提醒"）。
     * @param props hook 与操作回调。
     */
    function RestCard(props) {
      var notice = props.useNotice(function (current) {
        return current
      })
      var remaining = props.useRemaining(function (current) {
        return current
      })
      var doc = props.useStateDoc(function (current) {
        return current
      })

      if (notice === null) return null

      var minutes = Math.max(0, Math.ceil(remaining / 60))
      var hint = doc.enabled === false
        ? '提醒已关闭'
        : remaining > 0
          ? '下次提醒约 ' + String(minutes) + ' 分钟后'
          : '即将提醒'

      return h(
        'div',
        { style: CARD_STYLE, role: 'status', 'aria-live': 'polite', 'data-dsh-rest-notice': 'true' },
        h(
          'div',
          { style: TITLE_STYLE },
          h('span', { 'aria-hidden': 'true', style: { fontSize: '18px' } }, '☕'),
          h('span', { style: { flex: '1' } }, notice.title),
          h(
            'button',
            {
              type: 'button',
              'aria-label': '关闭',
              title: '关闭',
              style: {
                border: '0',
                background: 'transparent',
                color: '#8a9099',
                fontSize: '16px',
                lineHeight: '1',
                cursor: 'pointer',
                padding: '0 2px',
                marginLeft: 'auto',
              },
              onClick: props.onDismiss,
            },
            '×',
          ),
        ),
        h('p', { style: BODY_STYLE }, notice.body),
        h(
          'div',
          { style: { ...ROW_STYLE, justifyContent: 'flex-start', alignItems: 'center' } },
          h('span', { style: { color: '#8a9099', fontSize: '12px' } }, hint),
        ),
      )
    }

    // ------------------------------------------------------------------
    // 极小的外部 store：把定时器状态喂给 React
    // ------------------------------------------------------------------

    /**
     * 创建一个可在 React 外部更新的 store。
     * @param initial 初始值。
     */
    function createStore(initial) {
      var value = initial
      var listeners = new Set()
      return {
        get: function () {
          return value
        },
        set: function (next) {
          if (next === value) return
          value = next
          listeners.forEach(function (listener) {
            listener()
          })
        },
        subscribe: function (listener) {
          listeners.add(listener)
          return function () {
            listeners.delete(listener)
          }
        },
      }
    }

    /** 用 store 生成一个 useSyncExternalStore 风格的取值 hook。 */
    function makeHook(store) {
      return function useValue(selector) {
        return react.useSyncExternalStore(
          store.subscribe,
          function () {
            return selector(store.get())
          },
          function () {
            return selector(store.get())
          },
        )
      }
    }

    // ------------------------------------------------------------------
    // 设置面板
    // ------------------------------------------------------------------

    var FIELD_DEFS = [
      { key: 'enabled', kind: 'boolean', label: '启用定时提醒' },
      { key: 'intervalMinutes', kind: 'number', label: '提醒间隔（分钟）', min: 1, max: 720, step: 1 },
      {
        key: 'inAppMode',
        kind: 'select',
        label: 'dsh 内提示',
        options: [
          { value: 'off', text: '关闭' },
          { value: 'silent', text: '无声音' },
          { value: 'sound', text: '有声音' },
        ],
        hint: '提醒卡片在页面右下角，可点 × 手动关闭，否则 60 秒后自动消失。',
      },
      {
        key: 'systemNotification',
        kind: 'select',
        label: '系统通知',
        options: [
          { value: 'off', text: '关闭' },
          { value: 'whenPageClosed', text: '仅当页面不可见时' },
          { value: 'always', text: '每次都发' },
        ],
        hint: '关闭：任何情况都不弹。仅当页面不可见时：最小化、被遮挡或页面关闭时弹。每次都发：不论页面状态都弹。',
      },
      { key: 'message', kind: 'text', label: '提醒正文', maxLength: 200 },
    ]

    var FIELD_ROW_STYLE = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '16px',
      padding: '10px 0',
      borderBottom: '1px solid rgba(0,0,0,0.06)',
    }

    var FIELD_LABEL_STYLE = { color: '#1f2328', fontSize: '13px' }

    var INPUT_STYLE = {
      boxSizing: 'border-box',
      padding: '6px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(0,0,0,0.16)',
      font: 'inherit',
      fontSize: '13px',
      color: '#1f2328',
      background: '#ffffff',
    }

    /**
     * 文本设置项：本地维护草稿，停止输入一小段时间后才写回宿主。
     *
     * 不能每次 onChange 就写：中文输入法组合期间（拼音还没上屏）也会触发
     * onChange，写回后宿主值一变又把 value 覆盖回去，组合就被打断了。
     * 因此这里：
     *   1. 输入期间只更新本地草稿，不碰宿主；
     *   2. 组合结束后（compositionend）或停止输入 600ms 才提交；
     *   3. 宿主值变化时，只在没有未提交草稿的情况下同步进本地。
     */
    function TextSetting(props) {
      var def = props.def
      var draftPair = react.useState(props.value)
      var draft = draftPair[0]
      var setDraft = draftPair[1]
      var composingPair = react.useState(false)
      var composing = composingPair[0]
      var setComposing = composingPair[1]
      var lastLocalPair = react.useState(props.value)
      var lastLocal = lastLocalPair[0]
      var setLastLocal = lastLocalPair[1]
      // useRef 在部分精简运行时缺席，退化成普通对象。
      var timerRef = react.useRef !== undefined ? react.useRef(null) : { current: null }

      // 宿主值变了且本地没有待提交的改动 → 接受宿主值
      react.useEffect(
        function () {
          if (props.value !== lastLocal) {
            setDraft(props.value)
            setLastLocal(props.value)
          }
        },
        [props.value],
      )

      /** 停止输入后提交。组合期间不提交。 */
      var commitSoon = function (next) {
        if (timerRef.current !== null) window.clearTimeout(timerRef.current)
        timerRef.current = window.setTimeout(function () {
          timerRef.current = null
          if (next !== props.value) props.write(def.key, next)
        }, 600)
      }

      var update = function (next) {
        setDraft(next)
        setLastLocal(next)
        if (!composing) commitSoon(next)
      }

      react.useEffect(
        function () {
          return function () {
            if (timerRef.current !== null) window.clearTimeout(timerRef.current)
          }
        },
        [],
      )

      return h('input', {
        type: 'text',
        maxLength: def.maxLength,
        style: { ...INPUT_STYLE, width: '260px' },
        value: draft,
        disabled: props.disabled,
        onChange: function (event) {
          update(event.target.value)
        },
        onCompositionStart: function () {
          setComposing(true)
        },
        onCompositionEnd: function (event) {
          setComposing(false)
          // 组合结束后立即提交，不等防抖。
          if (timerRef.current !== null) {
            window.clearTimeout(timerRef.current)
            timerRef.current = null
          }
          var next = event.target.value
          if (next !== props.value) props.write(def.key, next)
        },
      })
    }

    /**
     * 设置卡片。所有改动即时写回本插件的 /config 接口（不依赖 dsh 的设置服务）。
     * @param props configStore（保存当前设置）与 repoll。
     */
    function SettingsCard(props) {
      var config = props.useConfig(function (current) {
        return current
      })
      var statusPair = react.useState('idle')
      var status = statusPair[0]
      var setStatus = statusPair[1]
      var failurePair = react.useState(undefined)
      var failure = failurePair[0]
      var setFailure = failurePair[1]

      var value = config || {}
      var writable = config !== null && config !== undefined

      var write = function (field, next) {
        setFailure(undefined)
        setStatus('saving')
        var patch = {}
        patch[field] = next
        post('config', patch).then(
          function (answer) {
            setStatus('idle')
            if (answer && answer.config) props.configStore.set(answer.config)
            // 设置变了，顺手刷新倒计时与提醒开关。
            props.repoll()
          },
          function (error) {
            setStatus('idle')
            setFailure('保存失败：' + (error instanceof Error ? error.message : String(error)))
          },
        )
      }

      var rows = []
      for (var i = 0; i < FIELD_DEFS.length; i++) {
        var def = FIELD_DEFS[i]
        var current = value[def.key]
        var control = null
        if (def.kind === 'boolean') {
          control = h('input', {
            type: 'checkbox',
            checked: current === true,
            disabled: !writable,
            onChange: function (def) {
              return function (event) {
                write(def.key, event.target.checked)
              }
            }(def),
          })
        } else if (def.kind === 'number') {
          control = h('input', {
            type: 'number',
            min: def.min,
            max: def.max,
            step: def.step,
            style: { ...INPUT_STYLE, width: '96px' },
            value: typeof current === 'number' ? current : 30,
            disabled: !writable,
            onChange: function (def) {
              return function (event) {
                var parsed = Number(event.target.value)
                if (Number.isFinite(parsed) && parsed >= def.min && parsed <= def.max) {
                  write(def.key, Math.round(parsed))
                }
              }
            }(def),
          })
        } else if (def.kind === 'select') {
          control = h(
            'select',
            {
              style: INPUT_STYLE,
              value: typeof current === 'string' ? current : 'whenPageClosed',
              disabled: !writable,
              // 必须立刻绑定 def：var 是函数作用域，裸引用会指向循环结束后的最后一个字段。
              onChange: function (def) {
                return function (event) {
                  write(def.key, event.target.value)
                }
              }(def),
            },
            def.options.map(function (option) {
              return h('option', { key: option.value, value: option.value }, option.text)
            }),
          )
        } else {
          control = h(TextSetting, {
            def: def,
            value: typeof current === 'string' ? current : '',
            disabled: !writable,
            write: write,
          })
        }
        rows.push(
          h(
            'div',
            { key: def.key, style: FIELD_ROW_STYLE, 'data-dsh-rest-field': def.key },
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
              h('label', { style: FIELD_LABEL_STYLE }, def.label),
              def.hint === undefined
                ? null
                : h('span', { style: { color: '#8a9099', fontSize: '11.5px', lineHeight: '16px' } }, def.hint),
            ),
            control,
          ),
        )
      }

      var testPair = react.useState('idle')
      var testState = testPair[0]
      var setTestState = testPair[1]
      var testDetailPair = react.useState(null)
      var testDetail = testDetailPair[0]
      var setTestDetail = testDetailPair[1]
      var onTest = function () {
        setTestState('sending')
        setTestDetail(null)
        post('remind', {}).then(
          function (doc) {
            // 先用回包驱动一次 ingest：页内提示由它按 inAppMode 决定，
            // 与系统通知是否发送无关。否则要等下一轮轮询才弹卡片。
            // 这里包一层 try：任何异常都不能让状态卡在「发送中」。
            try {
              if (typeof props.ingest === 'function') props.ingest(doc)
            } catch (error) {
              console.warn('[dsh-rest] 页内提示刷新失败', error)
            }

            // 再单独报告系统通知这一路的结果。
            if (doc.skipped === 'off') {
              // 系统通知关闭是用户自己的设置，不算异常，静默即可。
              setTestState('done')
              setTestDetail(null)
              return
            }
            if (doc.toastSupported === false) {
              setTestState('no-toast')
              setTestDetail(null)
              return
            }
            // 宿主端会等 PowerShell 执行完再回包，可直接拿到成功/失败原因。
            var toast = doc.toast || {}
            if (toast.ok === true) {
              setTestState('done')
              setTestDetail(null)
            } else {
              setTestState('toast-failed')
              setTestDetail(toast.detail ? String(toast.detail).slice(0, 200) : '未知原因')
            }
          },
          function () {
            setTestState('failed')
            setTestDetail(null)
          },
        )
      }

      var statusLine = null
      if (failure !== undefined) {
        statusLine = h('p', { style: { color: '#c4291f', fontSize: '12px', margin: '8px 0 0' } }, failure)
      } else if (status === 'saving') {
        statusLine = h('p', { style: { color: '#6a7079', fontSize: '12px', margin: '8px 0 0' } }, '保存中…')
      } else if (testState === 'sending') {
        statusLine = h('p', { style: { color: '#6a7079', fontSize: '12px', margin: '8px 0 0' } }, '正在发送…')
      } else if (testState === 'done') {
        statusLine = h('p', { style: { color: '#1a7f37', fontSize: '12px', margin: '8px 0 0' } }, '已立即提醒（倒计时已重置）。')
      } else if (testState === 'no-toast') {
        statusLine = h('p', { style: { color: '#9a6700', fontSize: '12px', margin: '8px 0 0' } }, '当前系统不支持桌面通知（需要 Windows、macOS 或带桌面环境的 Linux）。')
      } else if (testState === 'toast-failed') {
        statusLine = h(
          'p',
          { style: { color: '#c4291f', fontSize: '12px', margin: '8px 0 0', wordBreak: 'break-word' } },
          '系统通知投递失败：' + (testDetail || '未知原因'),
        )
      } else if (testState === 'failed') {
        statusLine = h('p', { style: { color: '#c4291f', fontSize: '12px', margin: '8px 0 0' } }, '请求失败，宿主端可能未运行。')
      }

      return h(
        'div',
        { style: { padding: '4px 0 16px' }, 'data-dsh-rest-settings': 'true' },
        h(
          'p',
          { style: { color: '#6a7079', fontSize: '12.5px', margin: '0 0 12px' } },
          writable ? '改动即时生效，无需重启 dsh。' : '正在读取设置…',
        ),
        rows,
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '16px' } },
          h(
            'button',
            {
              type: 'button',
              style: { ...buttonStyle(false), fontSize: '13px' },
              onClick: onTest,
              disabled: testState === 'sending',
            },
            testState === 'sending' ? '发送中…' : '立即提醒',
          ),
          h(
            'span',
            { style: { color: '#8a9099', fontSize: '12px' } },
            '按当前间隔，下次提醒约 ' + String(value.intervalMinutes === undefined ? 30 : value.intervalMinutes) + ' 分钟后。',
          ),
        ),
        statusLine,
      )
    }

    // ------------------------------------------------------------------
    // 插件体
    // ------------------------------------------------------------------

    function apply(ctx) {
      // 重载/重连时清掉上一份容器，保证只有一张卡。
      var stale = document.querySelector(HOST_SELECTOR)
      if (stale !== null) stale.remove()

      var container = document.createElement('div')
      container.setAttribute('data-dsh-rest-card', '')
      document.body.appendChild(container)

      var noticeStore = createStore(null)
      var remainingStore = createStore(0)
      var stateStore = createStore({ enabled: true, message: '', seq: 0, nextAt: null, intervalMinutes: 30 })

      var useNotice = makeHook(noticeStore)
      var useRemaining = makeHook(remainingStore)
      var useStateDoc = makeHook(stateStore)

      var lastSeq = null
      var disposed = false
      var pollHandle = null
      var tickHandle = null

      /** 收到宿主端状态：seq 增长则触发一次提醒。 */
      var ingest = function (doc) {
        stateStore.set(doc)

        // 设置改成"关闭"时，已经显示着的卡片要立刻撤掉，
        // 否则它会一直挂在页面上，看起来像设置没生效。
        if (doc.inAppMode === 'off' && noticeStore.get() !== null) {
          noticeStore.set(null)
          clearNoticeTimer()
        }

        if (lastSeq === null) {
          // 首次连接只建立基线，不为早已发生的提醒补弹窗。
          lastSeq = doc.seq
          return
        }
        if (doc.seq <= lastSeq) {
          lastSeq = doc.seq
          return
        }
        lastSeq = doc.seq
        var body = doc.message || '该休息一下了。'
        var mode = doc.inAppMode
        if (mode === 'silent' || mode === 'sound') {
          showNotice(body)
          if (mode === 'sound') playChime()
        }
      }

      /** 让当前卡片在若干秒后自动消失，避免无人理会时一直占着页面。 */
      var noticeTimer = null

      var clearNoticeTimer = function () {
        if (noticeTimer !== null) {
          window.clearTimeout(noticeTimer)
          noticeTimer = null
        }
      }

      /**
       * 显示提示卡，并挂上自动消失计时。
       * @param body 提醒正文。
       */
      var showNotice = function (body) {
        noticeStore.set({ title: '该休息了', body: body })
        clearNoticeTimer()
        noticeTimer = window.setTimeout(function () {
          noticeTimer = null
          noticeStore.set(null)
        }, NOTICE_AUTO_DISMISS_MS)
      }

      var poll = function () {
        if (disposed) return
        fetchState().then(ingest, function () {
          // 宿主端暂时不可达（重载/停用）：保持现状，等下一轮。
        }).finally(function () {
          if (disposed) return
          pollHandle = window.setTimeout(poll, POLL_INTERVAL_MS)
        })
      }

      /** 每秒刷新卡片上的倒计时。 */
      var tick = function () {
        if (disposed) return
        var doc = stateStore.get()
        var remaining = typeof doc.nextAt === 'number' ? (doc.nextAt - Date.now()) / 1000 : 0
        remainingStore.set(Math.max(0, remaining))
        tickHandle = window.setTimeout(tick, 1000)
      }

      /** 手动关闭：清掉卡片并取消自动消失计时。 */
      var onDismiss = function () {
        clearNoticeTimer()
        noticeStore.set(null)
      }

      var props = {
        useNotice: useNotice,
        useRemaining: useRemaining,
        useStateDoc: useStateDoc,
        onDismiss: onDismiss,
      }

      var root = null
      try {
        var createRoot = require('react-dom/client').createRoot
        root = createRoot(container)
        root.render(h(RestCard, props))
      } catch (error) {
        console.warn('[dsh-rest] 提示卡渲染失败', error)
      }

      poll()
      tick()

      // ---- 设置界面 -------------------------------------------------
      // 设置完全由本插件自己管：宿主端存 JSON、提供 /config 接口，
      // 这里只负责把界面挂到 dsh 的设置面板里。不依赖 dsh 的 settings 服务。
      var configStore = createStore(null)

      var loadConfig = function () {
        fetch(endpoint('config'), {
          cache: 'no-store',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          credentials: 'same-origin',
        })
          .then(function (response) {
            if (!response.ok) throw new Error('config failed: ' + response.status)
            return response.json()
          })
          .then(function (doc) {
            if (!disposed) configStore.set(doc)
          })
          .catch(function () {
            // 宿主端未就绪：界面上显示"正在读取设置…"，下一轮再试。
          })
      }

      var useConfig = makeHook(configStore)
      // ingest 让设置卡片把 /remind 的回包直接喂给提醒卡，立刻弹页内提示。
      var settingsFace = { configStore: configStore, useConfig: useConfig, repoll: poll, ingest: ingest }

      var slots = ctx.get('slots')
      if (slots !== undefined && slots !== null) {
        // 设置面板左侧导航里的一个分区 —— 主入口。
        try {
          slots.inject('settings.section', function () {
            return slots.register(
              {
                name: 'settings.section',
                id: 'dsh-rest',
                order: 160,
                label: function () {
                  return '休息提醒'
                },
                inject: function () {
                  return settingsFace
                },
              },
              SettingsCard,
            )
          })
        } catch (error) {
          console.warn('[dsh-rest] settings.section 注册失败', error)
        }

        // 「插件」页里 dsh-rest 这一行的「配置」入口（存在插件管理页时）。
        try {
          slots.inject('plugins.row.config', function () {
            return slots.register(
              {
                name: 'plugins.row.config',
                key: 'dsh-rest#rest-reminder',
                inject: function () {
                  return settingsFace
                },
              },
              function RowConfig(props) {
                if (props.view === 'summary') return '定时提醒你休息，可配置间隔与提醒方式。'
                return h(SettingsCard, props)
              },
            )
          })
        } catch (error) {
          // 精简部署里没有插件管理页：静默跳过。
        }
      } else {
        console.warn('[dsh-rest] 没有 slots 服务，设置界面无法挂载。')
      }

      loadConfig()

      // 可见性一变就立刻上报：窗口最小化时浏览器会节流定时器，
      // 等下一轮轮询可能要好几分钟，那时提醒早就该发了。
      var onVisibilityChange = function () {
        if (disposed) return
        // 从后台恢复时 rAF 可能已被浏览器挂起，重新拉起探测环。
        startRafProbe()
        fetchState().then(ingest, function () {})
      }

      // 窗口重新获得焦点也补一次上报（有些平台恢复时 visibilityState 不变）。
      var onFocus = function () {
        if (disposed) return
        fetchState().then(ingest, function () {})
      }

      ctx.effect(function () {
        try {
          document.addEventListener('visibilitychange', onVisibilityChange)
          window.addEventListener('focus', onFocus)
        } catch {
          // 环境不支持：退回轮询心跳
        }
        return function () {
          try {
            document.removeEventListener('visibilitychange', onVisibilityChange)
            window.removeEventListener('focus', onFocus)
          } catch {
            // 已被移除
          }
        }
      }, 'dsh-rest: visibility')

      // rAF 探测环：窗口最小化时时间戳停走，据此判定"不可见"。
      startRafProbe()

      ctx.effect(function () {
        return function () {
          disposed = true
          if (pollHandle !== null) window.clearTimeout(pollHandle)
          if (tickHandle !== null) window.clearTimeout(tickHandle)
          stopRafProbe()
          try {
            if (root !== null) root.unmount()
          } catch {
            // 容器已被移除
          }
          container.remove()
        }
      }, 'dsh-rest: reminder card')
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
