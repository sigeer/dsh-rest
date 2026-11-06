# dsh-rest

dsh 定时休息提醒插件。每隔一段时间提醒你起来活动一下，两种提醒方式可独立配置：

| 方式 | 实现 | 页面关闭时也生效 |
| --- | --- | --- |
| dsh 内提示 | 页面右下角提示卡（可点 × 关闭，60 秒后自动消失），提示音可选 | 否 |
| 系统通知 | 宿主端投递（Windows: PowerShell+WinRT；macOS: osascript；Linux: notify-send） | **是** |

默认间隔 30 分钟，零外部依赖。

## 安装

本包不经过 npm 发布，直接从源码仓库安装。

```bash
dsh plugin --profile <profile> add https://github.com/sigeer/dsh-rest
```

`<profile>` 换成你的 profile 名（`~/.dsh/profiles/` 下的目录名）。装完重启对应的 dsh 界面。

> 装之前先备份 profile：`~/.dsh/profiles/<profile>/cordis.patch.yml` 会被插件管理器改写。
>
> 如果目标 profile 是由桌面应用独占管理的（对 `desktop` 执行 CLI 会报
> `profile "desktop" is managed exclusively by the Electron application`），
> 就在应用内的插件管理器里安装，或改用 `web` 这类由 CLI 管理的 profile。

从 git 安装的副本不会自动跟随上游更新；改了插件源码需要重新安装，或改用
`dsh plugin --profile <profile> add link:<本仓库绝对路径>` 直连工作区。

## 设置

设置**不经过 dsh 的 settings 服务**，由插件自己管理：

- 存储：`~/.dsh/dsh-rest.json`（或 `$DSH_HOME/dsh-rest.json`）
- 读写：`GET /api/dsh-rest/config`、`POST /api/dsh-rest/config`
- 界面：注册到 dsh 设置面板的 **「休息提醒」** 分区（`settings.section`，order 160），
  同时挂一份到 **「插件」页 → dsh-rest → 该行 → 配置**

> 为什么不用 dsh 的 `Config` / schemastery？`link:` 方式安装的插件**不会安装自己的 dependencies**，
> 依赖 `@deepseek-ai/schemastery` 会导致整行导入失败（`ERR_MODULE_NOT_FOUND`），
> 连浏览器端一起起不来。现在宿主端只用 Node 内置模块，零外部依赖。

改动即时写入文件并重排计时，不需要重启 dsh。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关 |
| `intervalMinutes` | number (1–720) | `30` | 提醒间隔（分钟） |
| `inAppMode` | `off` / `silent` / `sound` | `sound` | dsh 内提示：关闭 / 无声音 / 有声音 |
| `systemNotification` | `off` / `whenPageClosed` / `always` | `whenPageClosed` | 系统通知的触发时机 |
| `message` | string (≤200) | 见下 | 提醒正文 |

默认正文：`该休息一下了：起身走走，看看远处，喝口水。`

### `systemNotification` 三档

- `off`：任何情况都不弹系统通知。
- `whenPageClosed`：仅在页面**不可见**时弹 —— 窗口最小化、被其他窗口完全遮挡、
  或页面已关闭（宿主仍在后台运行）都属于这一类。页面可见时不弹，避免与页内提示重复。
- `always`：不论页面状态，每次都弹。

### 「立即提醒」按钮

设置页底部，等价于**把倒计时清零**：走与自然到点完全相同的路径
（同样的可见性判定、同样的系统通知规则），触发后重新按设定间隔计时。
按钮会回报本次结果：

| 结果 | 显示 |
| --- | --- |
| 正常发送 | 绿色「已立即提醒（倒计时已重置）。」 |
| `systemNotification` 为 `off` | 同上（关闭是用户设置，不算异常） |
| 当前系统不支持桌面通知 | 黄色提示 |
| 投递失败 | 红色「系统通知投递失败：`<原因>`」 |

### 直接从 profile 覆盖默认值

```yaml
- insert:
    - id: rest-reminder
      name: 'dsh-rest'
      config:
        intervalMinutes: 45
        systemNotification: always
```

配置文件优先于这里的 `config`；两者都没有时用内置默认值。

## 交互

提示卡只做展示，不影响计时、也没有操作按钮：

- 点右上角 **×** 手动关闭
- 或者不管它，60 秒后自动消失

计时由宿主端自行推进，每次提醒后自动按设定间隔重排下一次。

## 接口

宿主端注册三条路由，全部只接受本机回环请求（非回环返回 403）：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/dsh-rest/state` | 返回状态快照；带 `?visible=1/0` 时同时上报页面可见性 |
| GET / POST | `/api/dsh-rest/config` | 读 / 部分更新设置（体里给哪些字段就改哪些） |
| POST | `/api/dsh-rest/remind` | 立即提醒：把倒计时清零并触发一次，然后重新计一轮 |

状态快照形如：

```json
{
  "seq": 4,
  "firedAt": 1793932500695,
  "nextAt": 1793934300695,
  "intervalMinutes": 30,
  "enabled": true,
  "inAppMode": "sound",
  "systemNotification": "whenPageClosed",
  "toastSupported": true,
  "lastToast": { "at": 1793932500900, "ok": true, "detail": "sent" },
  "pageOpen": true,
  "message": "该休息一下了：起身走走，看看远处，喝口水。"
}
```

浏览器端每 15 秒轮询一次；`seq` 增长即视为「宿主端判定该休息了」，据此弹出页内提示
（系统通知由宿主端按设置直接投递）。页面可见性变化时会立刻补一次上报，
不等到下一轮轮询。

## 目录结构

```
dsh-rest/
├── package.json          # 插件清单：main / dsh.bundle.patch / dsh.client
├── cordis.patch.yml      # 把自己插入 profile 插件清单的那一行
├── lib/
│   ├── index.js          # 宿主端：计时器、路由、系统通知、设置读写
│   └── client.js         # 浏览器端：轮询、提示卡、设置界面
└── README.md
```

## 页面可见性判定

「仅当页面不可见时」这一档依赖两条信号交叉判断：

1. `document.visibilityState === 'hidden'` —— 最直接的信号；
2. `requestAnimationFrame` 停止出帧超过 3 秒 —— 窗口最小化或被完全遮挡时
   合成器不再出帧，这是浏览器无法伪装的信号。

任一命中即视为不可见。两条都取不到时（老客户端/刚启动）退回心跳新鲜度
（75 秒内有过请求视为可见）。

## 系统通知的平台差异

- **Windows**：`powershell.exe` + WinRT Toast。归属用系统内置的 PowerShell AUMID，
  通知正文首行写入「DeepSeek Harness」，便于辨认来源。
  必须用 `-Command` 传脚本，**不能用 `-EncodedCommand`** —— 实测后者在同一段
  WinRT 代码下会静默退出（退出码 0、无输出），Toast 从未真正投递。
- **macOS**：`/usr/bin/osascript` 执行 AppleScript `display notification`，
  经 Foundation 的 base64 解码传递文本，避免中文与引号转义问题。
- **Linux**：`notify-send`（libnotify），参数直接传、不经 shell。
  需要桌面会话（D-Bus 通知守护进程）；纯终端或 ssh 会话会失败并返回原因。
- 其他平台 `toastSupported` 为 `false`。

三平台都**不引入任何 npm 依赖**：宿主端只用 Node 内置模块，通知全部交给系统自带的命令行工具。

## 已知限制

- 通知归属在 Windows 上显示为「Windows PowerShell」而非「DeepSeek Harness」。
  原因是 Toast 由 PowerShell 进程投递，且应用自己的 AUMID（`electron.app.DeepSeek Harness`）
  没有配套的开始菜单快捷方式，Windows 不认可 —— 实测该 AUMID 下通知只进通知中心、不弹横幅。
  让它可用需要写注册表并创建开始菜单快捷方式，本插件**不做这两件事**。
- 宿主端每次弹系统通知需要起一个子进程，约 300–800 ms。间隔通常以分钟计，影响可忽略。
- 计时状态只在内存里：dsh 重启后从头开始计时。
- 设置写入是"后写覆盖"：多个窗口同时改设置时，最后保存的生效。

## 许可

MIT，见 `LICENSE`。
