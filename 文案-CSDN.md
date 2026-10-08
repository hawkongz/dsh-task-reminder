# dsh-task-reminder 使用教程：DeepSeek Harness Web 任务完成提醒插件，Windows 系统弹窗 + 提示音，完成 / 等待 / 报错三种停止全覆盖

> 项目地址：https://github.com/hawkongz/dsh-task-reminder
> 平台：DeepSeek Harness（DSH Web 与桌面端）｜协议：MIT｜运行时依赖：零

## 目录

- 背景：任务跑完了，唯一的信号是运行灯灭了
- 插件效果
- 工作原理：三条检测通道与"一次一报、错误优先"
- 设置项一览
- 安装步骤
- 排障：弹窗不响怎么办
- 项目地址

## 背景：任务跑完了，唯一的信号是运行灯灭了

DeepSeek Harness 里 Agent 一个回合常要跑几分钟。这期间你切到别的窗口处理别的事，任务停止的唯一信号，是会话列表里的运行指示灯灭了。

这个信号有三个盲区：一是不区分正常完成与中途报错；二是 Agent 因 `ask_user_question` 挂起等你回答时，同样是"灯灭"——你不切回去，它就一直等；三是你不在浏览器前，屏幕上的任何变化都看不见。

## 插件效果

dsh-task-reminder 是浏览器端插件（宿主半侧 `index.js` 只多做一件事：DSH 桌面端里点弹窗时把窗口拉回前台——渲染进程的 `window.focus()` 拉不起最小化 / 收进托盘的窗口，只有主进程能 restore/show/focus，于是渲染进程经 Connection 精确 Fetch 路由请宿主代跑一次 `dsh://open`）。运行时零依赖。

任务停止时它做两件事：发一条 **Windows 系统弹窗**（Web Notification——操作系统右下角的原生通知，浏览器退到后台也看得到，点击它窗口回前台并打开对应会话），并响一声 Web Audio 合成的提示音。

在 DSH 桌面端（Electron）里还多一层保障：窗口最小化、或点关闭收进托盘之后，点右下角弹窗会**先把窗口自己拉回前台**，再打开对应会话——不用再去点任务栏或托盘图标。原理见上面宿主半侧那一段。

弹窗时机二选一：**任何情况都弹**（每次停止都提醒，不管窗口是否在前台）或 **仅非前台窗口**（切走标签页或浏览器窗口失焦时才提醒）。没有应用内卡片——系统弹窗是唯一的视觉通道。

三种停止原因全覆盖：**任务完成**、**等你回答**（Agent 阻塞在 `ask_user_question` / 计划评审）、**出错停止**（`api-session/error`——任何让回合失败的错误：网关 HTTP 错误如 400 / 401 / 429 / 500 / 502、服务商故障、连接失败）。

## 工作原理：三条检测通道与"一次一报、错误优先"

**检测用三条通道**：宿主转发事件 `api-session/status`、官方会话列表自身的 `running` 位、`uiSession.sessionStatus` 快照里的 `running` 位（与侧边栏运行指示灯同源；fork 子会话的列表投影陈旧时，这条路仍可靠）。三条通道共用一张边沿表，一次完成绝不会提醒两遍；分类在途时的重复边沿另由在途守卫与**回合号判据**双兜底：分类把 `turn/end` 的 `data.turn` 一并带出，同一个 turn 只报一次（不靠时间窗口），新 turn 在上一轮停止 5 秒内完成照报。

**分类保证一次停止只报一次，错误优先。** 停止到达时，插件读会话持久日志里最后一条 `turn/end` 的 reason：`completed`（含 `max-tokens` 截断）报完成；`error` 只报错误、正文取网关原文，绝不出现完成弹窗；取消（`aborted`）不报。读取时同时取最后一条 `turn/start`——最新回合未闭合时（读到的是上一回合的 `turn/end`）重试等它落盘，所以点「停止」不会被误报成"任务完成"。同一次停止的完成→完成重复边沿按回合号确定性丢掉；分类读不到原因（也就读不到回合号）时才回退：完成弹窗先发，5 秒内后到的同一停止的错误会撤回它，只留错误。

提示音与弹窗在同一次处理里发出，且提示音不管窗口在不在前台，每次停止都响。

## 设置项一览

独立设置页：**设置 → 任务提醒**。八个设置项全部持久化在浏览器本地存储，重启后仍在。

| 设置项 | 默认 | 持久化键 |
| :--- | :--- | :--- |
| 系统弹窗 | 开 | `dsh.task-reminder.notify` |
| 弹窗时机（任何情况都弹 / 仅非前台窗口） | 任何情况都弹 | `dsh.task-reminder.notify-mode` |
| 通知语言（简体中文 / English） | 跟随界面 | `dsh.task-reminder.notify-language` |
| 完成提示音 | 开 | `dsh.task-reminder.sound` |
| 提示音音效（四种合成 + 自定义） | 两声·经典 | `dsh.task-reminder.sound-choice` |
| 提示音音量（0–100） | 80 | `dsh.task-reminder.volume` |
| 子智能体提醒（默认关） | 关 | `dsh.task-reminder.subagent` |
| 弹窗一直挂着（默认关） | 关 | `dsh.task-reminder.sticky` |
| 自定义音效文件（本机音频，字节存 IndexedDB） | 无 | `dsh.task-reminder.custom-sound` |

「恢复默认」一键写回上表默认值。四种音效（两声经典 / 三声上扬 / 上升琶音 / 圆润三角波）点选即按当前音量发声，没有单独的试听按钮。

浏览器控制台另有两个排障钩子：

```js
// 前台状态、八个配置、通知权限、三条通道计数、重复抑制次数、最近几条停止
__dshTaskReminder.state()

// 立刻发一条"任务完成"弹窗并放一声，不等任务停止
__dshTaskReminder.test()
```

## 安装步骤

前置条件：跑着 `web` profile 的 DSH（`dsh web`）、`PATH` 上有 pnpm（`dsh plugin` 会把参数转给它）、Node.js 20 或更新（跑自检用）。

```powershell
# Windows（PowerShell），任意目录执行
dsh plugin --profile web add @hawkongz/dsh-task-reminder
```

```bash
# macOS / Linux
dsh plugin --profile web add @hawkongz/dsh-task-reminder
```

一条命令同时完成两件事：把包装进 profile 目录，并把它追加进 profile 的 `dsh.profile.bundles`——不需要单独登记。想跟 GitHub 仓库最新代码，可换 `github:hawkongz/dsh-task-reminder`（带 `#<tag>` 钉某个发布标签）。本包不带构建脚本，pnpm 不会拦安装。

> **发版当天注意：** pnpm 11 默认打开 `minimumReleaseAge`（1 天）。刚发布的版本当天解析不到，裸命令会装上上一版；想当天就装到新版就把版本号钉住，例如 `dsh plugin --profile web add @hawkongz/dsh-task-reminder@1.6.2`。

然后重启宿主并硬刷新浏览器（宿主只在进程启动时读客户端产物，浏览器又会缓存旧 bundle，两步都省不掉）：

```bash
dsh web
```

验证登记：

```powershell
dsh --profile web --dump-config | Select-String task-reminder
```

打开「设置 → 任务提醒」：页面在，插件就活了。首次加载浏览器会弹一次通知权限申请，选「允许」即可（权限按 Origin 共享，本站点授权一次，所有插件通用）。

**DSH 桌面端（Electron）**同理，只是 profile 名换成 `desktop`：

```powershell
dsh plugin --profile desktop add @hawkongz/dsh-task-reminder
```

装完退出并重新打开桌面端即可（桌面端没有浏览器缓存那一步，不用硬刷新）。弹窗、提示音、三种停止检测、全屏排障等行为与 Web 端完全一致，唯一多出来的是「点弹窗时把最小化 / 收进托盘的窗口拉回前台」（见上文）。验证登记：

```powershell
dsh --profile desktop --dump-config | Select-String task-reminder
```

自检（不需要浏览器、不联网）：`npm test` 跑三套 —— 跨半侧契约 19 条、浏览器半侧 501 条、宿主半侧 66 条，共 591 条断言。跨半侧契约把两半放进同一个进程对拍包名 / 三条路由 / 版本号，把宿主的检查更新与升级答复喂进渲染侧状态机，并用同一张版本表对拍两半各自那份 semver 实现。浏览器半侧用桩服务覆盖模块身份、接线、边沿判定、三条通道去重与回合号重复边沿抑制、未闭合回合不误报完成、两种弹窗时机、三种停止原因与分类对账、每种音效的振荡器参数、通知权限路径、点弹窗落到你这次提问的位置、自定义音效与资源回收等全部路径；宿主半侧覆盖三条路由、检查更新 / 就地升级与桌面窗口唤醒链路。

## 排障：弹窗不响怎么办

按从便宜到贵的顺序查链路：

1. 控制台执行 `__dshTaskReminder.state()`：`notificationSupported` 必须为 `true`、`notificationPermission` 必须为 `granted`，且每次完成后 `stats.notifications` 要往上加。计数在动，说明浏览器已接受 toast，丢失在系统展示层，不是插件的问题。
2. 权限还是 `default`：点设置页「系统弹窗」行下的「申请通知权限」按钮，再选「允许」；是 `denied`：这一档**故意不提供按钮**（不给被拒的站点反复弹框），去浏览器地址栏的站点权限里放行通知即可，权限一变按钮/提示就跟着变；把该站点改成「询问」则按钮会重新出现。
3. 浏览器收了但屏幕上没有：那是 Windows 在压浏览器 toast。查「设置 → 系统 → 通知」（总开关**和**浏览器这一项的应用开关）、「请勿打扰」设为「关」，并按 `Win + N` 打开通知中心看看。
4. 十秒隔离测试：页面控制台执行 `new Notification('DSH test', { body: '能看到我吗' })`。这条也不显示，就是 Windows / 浏览器在压，任何插件代码都绕不过。
5. **全屏看视频 / 玩游戏时不弹横幅、退出全屏也不补弹？** 这是 Windows，而且系统里有开关：前台有全屏应用时，Windows 会隐藏通知横幅——**连优先级通知一起隐藏**——提醒只进通知中心（`Win + N`），被压掉的横幅退出全屏后也不会重放。开关在「**设置 → 系统 → 通知 → 请勿打扰 → 在全屏模式下使用应用时（优先级通知横幅也会隐藏）**」，关掉它，横幅就会盖在全屏窗口上。我在 Windows 11（build 26200）上实测过：开着时这条规则把全屏绑到「仅限闹钟」档，连你加进优先名单的应用也不放行；关掉后绑定消失，弹窗立刻恢复正常。插件侧绕不过这件事（Web Notification 没有绕过「请勿打扰」的接口），但提示音照常响，弹窗也一直躺在通知中心里。

提示音没声：音量可能为 0、标签页可能被静音、或自动播放策略在首次交互前挂起了 AudioContext——在页面里点一下或按个键即可。一个浏览会话的第一声可能慢几秒（Chrome 首次音频渲染要启动系统音频设备，且只允许从用户手势触发），打开页面后先在页面里点一下可预热，之后提示音即时。

## 项目地址

https://github.com/hawkongz/dsh-task-reminder — MIT 协议，欢迎 Star / Issue。
