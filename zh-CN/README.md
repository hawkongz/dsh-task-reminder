<div align="center">
  <h1>dsh-task-reminder</h1>
  <p>DeepSeek Harness（Web UI 与桌面端）的对话任务完成提醒插件</p>

  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../LICENSE)
  [![Platform](https://img.shields.io/badge/Platform-DeepSeek%20Harness-lightgrey)](https://github.com/deepseek-ai)
  [![Stars](https://img.shields.io/github/stars/hawkongz/dsh-task-reminder)](https://github.com/hawkongz/dsh-task-reminder/stargazers)
  [![npm](https://img.shields.io/npm/v/@hawkongz/dsh-task-reminder)](https://www.npmjs.com/package/@hawkongz/dsh-task-reminder)
  [![下载量](https://img.shields.io/npm/dt/@hawkongz/dsh-task-reminder?label=%E4%B8%8B%E8%BD%BD%E9%87%8F)](https://www.npmjs.com/package/@hawkongz/dsh-task-reminder)

  <p><strong>语言：</strong> <a href="../README.md">English</a> | <a href="README.md">简体中文</a></p>
</div>

---

## 📋 目录

- [功能特性](#-功能特性)
- [快速开始](#-快速开始)
- [安装](#-安装)
- [使用方法](#-使用方法)
- [常见问题](#-常见问题)
- [标签](#-标签)
- [贡献指南](#-贡献指南)
- [许可证](#-许可证)

---

Agent 回合在 DeepSeek Harness 里跑着，你却切到别的窗口看别的事——任务跑完了，
唯一的信号只是会话列表里的运行指示灯灭了。这个插件把这一刻变成真正的提醒，
而且不用离开你已经在用的浏览器界面。

当一轮对话任务停止，插件发一条 **Windows 系统弹窗**（Web Notification——操作系统
右下角的原生通知，浏览器退到后台也看得到；点它回到该会话，并落到你这次提问的位置），并响一声合成提示音。
三种停止原因都覆盖：**任务完成**、**Agent 抛出问题等你回答**（ask_user_question /
计划评审挂起——只读 uiSession.sessionStatus 快照的出现边沿，不碰问答应答链）、
**出错停止**（api-session/error——任何让回合失败的错误：网关 HTTP 错误如 400 / 401 / 429 / 500 / 502、服务商故障、连接失败）。同一次停止只报一次（错误
优先：停止到达时按会话持久日志里 `turn/end` 的原因分类——completed（含 max-tokens 截断）报完成，error 只报错误、正文是网关原文、不出现完成弹窗，取消（aborted）不报；读取时同时取最后一条 turn/start，最新回合未闭合（读到的是上一回合的 turn/end）时重试等它落盘，点停止不会误报完成；提示音与弹窗在同一次处理里发出。分类不可用时完成弹窗先发，5 秒内后到的同停止错误会撤回它，只留错误。**「同一次停止」按回合号判定**：分类把 turn/end 的 `data.turn` 一并带出，与每个会话记下的「最近一次结清的回合号」相等就确定性丢掉——重复通道与列表陈旧回放都不会双弹，而上一轮刚停、新任务开始后 5 秒内完成的新回合照报（桌面端通道一稀疏、上一轮的票据没人清，旧的时间窗恰好会把这种完成整条吞掉）；5 秒窗口只留给「错误优先」两个方向与读不到回合号时的兜底）。弹窗时机有两种：**任何情况都弹**（不管浏览器窗口是否在前台，
每次停止都弹）与 **仅非前台窗口**（切走标签页或浏览器窗口失焦、
人在别的应用时才弹）。没有应用内卡片——
系统弹窗是唯一的视觉通道。所有配置都在独立设置页里完成，并持久化到重启之后。

提醒逻辑全在浏览器半侧——宿主半侧（`index.js`）只多做两件事。第一件只在 DSH
桌面端（DSH Desktop）里做：**点弹窗时把应用窗口拉回前台**。Electron 的渲染进程
拉不起已被最小化或收进托盘的窗口，所以点击弹窗时页面会请宿主半侧（`POST`
`api/task-reminder/window-activation`，一条 Connection 精确 Fetch 路由）再启动
一份应用：第二份拿不到单实例锁、立刻退出，第一份随即走
`second-instance` → `focusPrimaryWindow()`。桌面端之外没人调用这条路由，真被调用
也只会回 501。

第二件对所有人生效：设置页底部「检查更新」那两条路由——一条问 npm 上最新发布的是
哪个版本，另一条交给 DSH 自己的插件管理服务把包升上去。提醒功能一点都不依赖它们；
没有 web 服务器的组合里这两条路由根本不注册。

## ✨ 功能特性

* **Windows 系统弹窗，唯一视觉通道：** 走 Web Notification API，以操作系统 toast
  的形式弹出，应用退到后台也看得到；点击弹窗窗口回前台、打开对应会话**并落到你这次
  提问的位置**（人读消息是自上而下的，从这里往下读就行）——浏览器里 `window.focus()`
  就够，DSH 桌面端里由宿主半侧把最小化 /
  收进托盘的窗口拉起来（见[桌面端（DSH Desktop）](#桌面端dsh-desktop点弹窗把窗口拉回前台)）。
  DSH 没有对外暴露滚动接口（`openSession(target)` 不收参数，`ctx.uiConversation`
  也没有导航能力，聊天视图自己的滚动不对包外导出），所以插件做的是「读者要做的事」：
  打开会话后把**你自己的最后一条消息**（会话流列 `[data-chat-flow]` 里
  `[data-chat-flow-kind="user"]` / `"steering"` 的最后一行）对到对话滚动口顶部下方
  24px 处 —— 和应用自己的「跳到第 N 轮」是同一个落点。应用的 `reading.restore()`
  可能晚于第一拍落地，所以会连着复查几拍；某个方向已经滚不动（到顶 / 到底）也算就位，
  免得每一拍再叠一点像素把视口推走。三类弹窗（完成 / 出错 / 等待操作）都是这个落点。
  将来 DOM 变了最多丢掉这一步，绝不会影响「打开会话」；结果记在
  `state().stats.lastQuestionJump`（`aligned` / `no-column` / `other-session` /
  `no-question` / `no-scroller` / `timeout`）。三种停止
  原因都覆盖：**任务完成**、**等你操作**（按挂起类型分三个标题：**审批请求** /
  **提问** / **方案待确认**，认不出类型时退回「等待你的回答」；只读
  `uiSession.sessionStatus` 快照的出现边沿，绝不参与 user-questions
  应答链）、**出错停止**（`api-session/error`——任何让回合失败的错误：网关 HTTP 错误如 400 / 401 / 429 / 500 / 502、服务商故障、连接失败）。**审批的通知上直接带「同意 / 拒绝」两个按钮**：点一下就是审批卡片的
  「允许一次 / 拒绝」（调审批对象自己的 `answer('allowed-once' | 'rejected')`），
  不用切回页面（见[在通知上直接裁决](#在通知上直接裁决)）。审批弹窗的正文是**「工具名：理由」**——本地化的 `displayReason` 按通知语言取，退回未本地化的 `reason`，两者都空才退回会话名（1.6.1 起；此前的 bug 是正文恒等于会话名，通知上带着「同意 / 拒绝」却看不出要批准什么）。通知 tag **每条独立**（1.5.5 的行为，1.6.2 改回来）：后一条不顶掉前一条，通知中心里逐条留着。「按类型固定 tag + renotify」看着更清爽，但 Windows 会把上一条横幅替换掉，**被替换的那条在通知中心里点不动**（Electron 在 Windows 上不投递通知中心条目的 click，electron#29461），现场表现就是「点了通知窗口抬不起来」。同一次停止
  只报一次、错误优先：停止到达时读会话持久日志最后一条 `turn/end` 的 reason 分类——completed / max-tokens 报完成，error 只报错误（正文取网关原文），aborted / blocked / interrupted 不报；读时同时取最后一条 turn/start，最新回合未闭合时重试等本次回合的 turn/end 落盘（取消不误报完成）；提示音与弹窗同轮发出。分类读不到才退回完成弹窗，5 秒内后到的同停止错误会撤回它只留错误（一次停止一次提醒）。**「同一次停止」按回合号判定（1.5.4）**：分类同时带出 turn/end 的 `data.turn`，与每个会话记下的「最近一次结清的回合号」相等就确定性丢掉，不再看 5 秒窗口；5 秒窗口只留给「错误优先」两个方向（error→completion 不报、completion→error 撤回）与读不到回合号时的兜底（`api-session/error` 事件本身不带回合号；兜底路径自己报的那次停止也没有号可记，它的重复边沿仍由窗口兜着——这里有意保守：宁可漏掉这 5 秒内的新回合，也不冒重复弹窗的风险）。重复边沿（分类在途时列表陈旧回放）由在途守卫与回合号判据双兜底，只报一次；新回合在上一轮停止 5 秒内完成照报——否则桌面端通道一稀疏时那次完成会被整条吞掉。
  时机有两种：**任何情况都弹**（每次停止都弹，不管窗口在不在前台）与
  **仅非前台窗口**（切走标签页或浏览器窗口失焦时才弹），设置页里切换。首次
  装载时代码会替用户申请一次权限（浏览器的 Notification API 没有免权限通道——
  只在页面内画东西的插件才不需要这一步；权限按 Origin 共享，本站点授权一次，
  所有插件通用）；之后权限若被重置，设置页「系统弹窗」行下的「申请通知权限」
  按钮可以再申请。被拒绝或不支持时，设置页给出明确提示，而不是假装生效。
* **子智能体会话默认不提醒：** lead 派出的子代理、以及其他智能体自己起的子智能体，
  它们的停止都发生在各自独立的会话里——对插件来说只是又一个 `sessionId`，一个回合
  里很容易连响好几声，而你真正在等的那个对话还在跑。这些会话在三条检测通道与
  `api-session/error` 里都被同一道闸挡下（边沿、分类、提示音、弹窗一律不参与），
  判据只取官方会话列表行上的 `origin === 'subagent'`——也就是官方侧边栏用来把子会话
  挡在列表外的那个字段；fork 出来的会话带 `parentId` 但没有这个 origin，照旧提醒。
  少掉的提醒信息量为零：你盯着的那个会话自己会报完成。设置页里的「子智能体提醒」
  开关（**Subagent reminders**）可以把子智能体的完成 / 等待回答 / 出错重新打开，
  出厂默认关闭，「恢复默认」也会把它关回去。
* **四种合成提示音 + 自定义上传：** 两声（经典）、三声上扬、上升琶音、圆润三角波
  ——全部用 Web Audio 现场生成，不带任何音频文件。第五档「自定义」播放你自己选
  的本机音频：字节存进浏览器的 IndexedDB（不是本地存储），用 `decodeAudioData`
  解码后走同一个音量增益播放——不上传、不进包。点选音效立即按当前音量发声，
  没有多余的「试听」按钮。IndexedDB / 文件 / 解码任一环节不可用时，提醒回落到
  第一种合成音效，不会变哑。提示音不管窗口在不在前台，每次停止都响。
* **独立设置页：** 「设置 → 任务提醒」（「设置 → 通用」里不再占行），一键恢复
  默认；页面最底部还有 **检查更新** —— 显示当前版本、问 npm（官方源 + 国内镜像）
  最新发布是哪个版本，然后一键交给 DSH 自己的插件管理服务升级。见
  [检查更新](#检查更新)。
* **三通道完成检测、天然去重：** 宿主转发事件 `api-session/status`、官方会话
  列表自身的 `running` 位、以及 `uiSession.sessionStatus` 快照里的 `running` 位
  （与 sidebar 运行指示灯同源；fork 子会话的列表投影不可靠——陈旧 / 不翻——
  时这条路仍可靠）共用一张边沿表，一次完成绝不会提醒两遍；分类在途时的重复
  边沿另由在途守卫与回合号判据（同一个 turn 只报一次，新 turn 不会被当成重复）
  兜底。
* **全部配置持久化在浏览器本地存储**，重启后仍在，因此宿主半侧不需要注册任何
  设置命名空间。

## 🚀 快速开始

> **前置条件：** 跑着 `web` profile 的 DeepSeek Harness（`dsh web`）、
> `PATH` 上有 pnpm（`dsh plugin` 命令会把参数转给它），以及一个能硬刷新的
> 浏览器。

**第一步 — 打开终端**

* macOS / Linux：打开终端（Terminal）。
* Windows：`Win + R`，输入 `powershell`，回车。

**第二步 — 一条命令完成安装与登记**

`dsh plugin` 把包装进 profile 目录，并顺手把它追加进 profile 的
`dsh.profile.bundles`——不需要单独登记：

```powershell
# Windows（PowerShell）——在任意目录执行都行
dsh plugin --profile web add @hawkongz/dsh-task-reminder
```

```bash
# macOS / Linux
dsh plugin --profile web add @hawkongz/dsh-task-reminder
```

装的是 npm registry 上的已发布包——和其他 DSH 插件的装法完全一样。（裸名 `dsh-task-reminder` 已确定拿不到：npm 判定它与现存包
`dsh-taskreminder` 过于相似、永久拒发，所以 registry 形式只能带 scope。）桌面端
（DSH Desktop）用同一条命令、把 `--profile web` 换成 `--profile desktop`，装完重启
桌面端即可，细节见[安装](#-安装)一节。

> **发版当天安装注意。** pnpm 11 默认打开 `minimumReleaseAge`（1440 分钟，即 1 天），
> 所以今天刚发的版本还解析不到：上面这条裸命令会打出 `… 1.6.1 (1.6.2 is available)`
> 并装上上一版。想当天就装到新版，就钉版本 ——
> `dsh plugin --profile web add @hawkongz/dsh-task-reminder@1.6.2`（pnpm 会把这个
> 具体版本加进豁免名单）—— 或者在 profile 的 `pnpm-workspace.yaml` 里设
> `minimumReleaseAge: 0`，再或者等满一天。同样的现象见「常见问题」一节。

想改从 GitHub 仓库装（默认分支，或钉某个发布标签），用 `github:` 形式：

```powershell
# 默认分支
dsh plugin --profile web add github:hawkongz/dsh-task-reminder

# 想装指定版本而不是默认分支，就带上标签
dsh plugin --profile web add github:hawkongz/dsh-task-reminder#<tag>
```

**第三步 — 重启并验证**

重启宿主（`dsh web`），再硬刷新浏览器（`Ctrl + F5`）。改过 `client.js` 之后
浏览器不会热读，所以每次更新这两步都省不掉。验证登记结果：

```powershell
dsh --profile web --dump-config | Select-String task-reminder
```

> **完成。** 打开「设置 → 任务提醒」：页面在，插件就活了。首次装载浏览器会弹一次
> 通知权限申请，选「允许」即可。随便找个会话跑一个任务，等着收提醒——默认
> 「任何情况都弹」时机下，就算你盯着对话窗口，弹窗也会出现。

## 📦 安装

### 前置条件

* 跑着 `web` profile 的 DeepSeek Harness（`dsh web`）。
* `PATH` 上有 pnpm——`dsh plugin` 会把参数原样转给 profile 目录里的 pnpm。
* Node.js 20 或更高（自检要用）。
* 支持 Web Audio、最好也支持 Notification API 的浏览器。

### 用 dsh plugin 安装

```powershell
dsh plugin --profile web add @hawkongz/dsh-task-reminder
```

一条命令同时做两件事：把包装进 profile，以及把
`@hawkongz/dsh-task-reminder` 追加进 profile 的 `dsh.profile.bundles`（行
本身的 id 是 `task-reminder`）；随后加载器应用 bundle 自带的
`cordis.patch.yml`，插入 `task-reminder` 行。本包不带任何构建脚本，pnpm 不会
拦住安装（那类需要在 profile 的 `pnpm-workspace.yaml` 里加 `allowBuilds`
的情况只发生在带 prepare 脚本的 git 托管包上）。

想装**指定的那一个版本**（而不是 registry 今天解析出来的那个）——新版还没满
pnpm 11 的「一天冷静期」时就必须这样做，见上一节——把版本钉上：

```powershell
dsh plugin --profile web add @hawkongz/dsh-task-reminder@1.6.2
```

pnpm 会把这条豁免写进 profile 的 `pnpm-workspace.yaml`（`minimumReleaseAgeExclude`）
并立刻装上。想确认某个 profile 实际装的是哪版：

```powershell
(Get-Content $env:USERPROFILE\.dsh\profiles\web\node_modules\@hawkongz\dsh-task-reminder\package.json | ConvertFrom-Json).version
```

桌面端（DSH Desktop，Electron）跑的是同一个包，只是装在**它自己的 profile** 里
——把 `web` 换成 `desktop`，装完重启桌面端即可（桌面端不存在浏览器缓存那一步，
不用硬刷新）：

```powershell
dsh plugin --profile desktop add @hawkongz/dsh-task-reminder
```

提醒行为与 Web 端完全一致，只多一步桌面端独有的「点弹窗把窗口拉回前台」，
见[桌面端（DSH Desktop）](#桌面端dsh-desktop点弹窗把窗口拉回前台)。

包里带着插件需要的全部文件：`index.js`（宿主半侧）、`client.js`（浏览器半侧）、
`cordis.patch.yml`（bundle 行），以及 `test/` 下的自检脚本。

### 卸载

```powershell
dsh plugin --profile web remove @hawkongz/dsh-task-reminder
```

`remove` 一并卸包并整理 bundle 清单。然后重启 `dsh web`，让这一行从组合配置里
消失。

### 本地开发安装

要改代码而不是用发布包，就把 checkout 链进 profile（`plugin_manager` 工具的
`install_bundle` 内部做的就是这件事）：

```powershell
# Windows（PowerShell）——在放着 checkout 的目录执行
dsh plugin --profile web add link:.\dsh-task-reminder

# 或者用绝对路径，在任意目录执行
dsh plugin --profile web add link:C:\Users\20105\OneDrive\Desktop\ds\dsh-task-reminder
```

记住重启规则：改 `client.js` → 跑 `npm test` → 重启
`dsh web` → 硬刷新浏览器——宿主不会热读改过的 `client.js`。

## 📖 使用方法

### 设置页

「设置 → 任务提醒」（设置导航 order 44）：

| 设置项 | 默认 | 持久化键 |
| :--- | :--- | :--- |
| 系统弹窗 | 开 | `dsh.task-reminder.notify` |
| 弹窗时机（任何情况都弹 / 仅非前台窗口） | 任何情况都弹 | `dsh.task-reminder.notify-mode` |
| 通知语言（简体中文 / English） | 跟随界面 | `dsh.task-reminder.notify-language` |
| 子智能体提醒 | 关 | `dsh.task-reminder.subagent` |
| 弹窗一直挂着 | 关 | `dsh.task-reminder.sticky` |
| 完成提示音 | 开 | `dsh.task-reminder.sound` |
| 提示音音效（四种合成 + 自定义） | 第一种（两声·经典） | `dsh.task-reminder.sound-choice` |
| 自定义音效文件 | 无 | `dsh.task-reminder.custom-sound`（元数据；音频字节在 IndexedDB） |
| 提示音音量（0–100） | 80 | `dsh.task-reminder.volume` |

「恢复默认」一键写回：弹窗开（任何情况都弹）、通知语言跟随界面、子智能体提醒关、
弹窗不再一直挂着、提示音开、第一种音效、音量 80。已上传的自定义音效文件会保留——
要删就在「自定义音效」行点「清除」。

**弹窗时机**这一行把两档各自的含义都写在标题下面（两档上下排，一档配一行说明）：

* 「任何情况都弹」：任务一完成就弹，不管浏览器窗口是否在前台；
* 「仅非前台窗口」：切走标签页或浏览器窗口失焦（人在别的应用）时才弹。

**通知语言**只有两档——简体中文 / English；「跟随界面」是默认行为而不是第三个选项，
这一行显示的是**当前生效**的语言（没钉住时就是界面语言，界面切了它跟着变）。它只影响
通知文案（标题、正文、审批按钮文字）；设置页本身永远跟随界面语言，把通知钉成英文不会
把设置页也变成英文。

**弹窗一直挂着**（默认关）会给五类通知都加上 `requireInteraction`：横幅不自动收进
通知中心，你不点掉它就一直挂着。这个开关的来历是 Windows 的一个行为——**没被点过的
横幅可能永远不把点击投递给页面**（Electron 在 Windows 上不投递通知中心条目的 click，
electron#29461），现场就是「点了通知什么都没发生」。让横幅一直挂着，点击才必定送得到；
代价是每个弹窗都得你自己收掉。

### 检查更新

设置页最后一行是版本与一个按钮：

| 状态 | 这一行怎么说 | 按钮 |
| :--- | :--- | :--- |
| 还没查过 | `当前版本 v1.6.2` | **检查更新** |
| 正在检查 | `正在检查更新…` | 置灰 |
| 已是最新 | `当前版本 v1.6.2，已是最新版本` | **检查更新** |
| 有新版本 | `当前版本 v1.6.1，发现新版本 v1.6.2；更新后重启 DSH 生效` | **更新到 v1.6.2** |
| 正在更新 | `正在更新到 v1.6.2…` | 置灰 |
| 更新完成 | `已更新到 v1.6.2：重启 DSH 后生效` | **刷新页面** |
| 失败 | `检查更新失败：<原始说明>` / `更新失败：<原始说明>；若其实已经装完，重启 DSH 后以实际版本为准` | **检查更新** |

判断有没有新版不靠猜：宿主半侧**同时**问 npm 官方源与 `registry.npmmirror.com`，
取两边答出来的更高版本 —— 镜像还没同步完，不会把「其实有新版本」说成「已是最新」；
其中一个源连不上也照样有另一个的答案。只有两个源都不通才报失败，而不是假装已经最新。

而且它不依赖「代理必须是活的」。Node 24 在 `NODE_USE_ENV_PROXY=1` 时让 `fetch` 按
`HTTPS_PROXY` 走代理，本地代理恰好关着（Clash 没开、公司代理断线）时就会
`ECONNREFUSED 127.0.0.1:7897`，而直连其实完全正常。所以每个源都用**两条路并行问**：
一条直连 HTTPS（`agent: false`，绕开 Node 装在全局 agent 上的代理），环境变量确实
开着代理时再加一条走代理的路；谁先答用谁的。失败说明也会带上真正的原因
（`ECONNREFUSED …` / `ENOTFOUND …`），不是 undici 那句光秃秃的 `fetch failed`。

真正的升级交给 **DSH 自己的插件管理服务**（`pluginManager.installBundle`），不是自己
拼一条 `pnpm` 命令行：只有它知道这个 profile 的包管理器怎么起（DSH 桌面端把应用内置
的 pnpm 当 launcher facts 传进来）、一个源不通时怎么依次换下一个、装失败时怎么把
`package.json` 与锁文件回滚，以及装完的结果。因为依赖本来就在，它会返回
`restart-required`：把新版本落到磁盘、不动正在跑的这棵树 —— 提出这次更新的插件本身
就跑在这棵树里，这正是我们要的。重启 DSH（纯浏览器里刷新页面）就是新版本。

两种情况如实拒绝，而不是做一半：

* **本地开发安装**（profile 的 `package.json` 里是 `link:` / `file:`）：仍然告诉你
  有新版，但不给一个会把你的工作目录换成发布版的按钮。
* **没有插件管理服务的组合**：如实说明，并给出手动升级命令
  （`dsh plugin add @hawkongz/dsh-task-reminder@latest`）。

没有上传、没有遥测：检查就是一次 HTTPS `GET` 取 `dist-tags.latest`，更新就是在你自己
的 profile 里做一次正常的包安装。

### 在通知上直接裁决

**审批**的通知上直接带 **同意 / 拒绝** 两个按钮：点一下走的就是审批卡片自己那条
`answer('allowed-once' | 'rejected')`——「同意」等于「允许一次」，不多放行任何东西——
而且不会把窗口拽到前台（在通知上做决定不该抢焦点）。等待在别处（审批卡片、另一个
标签页）被裁决后，它的通知会被收掉；等待已经被新请求顶替时，陈旧通知再点也不会误裁。

按钮需要 Service Worker，所以这份 `client.js` 同时被注册成插件自己的 worker
（脚本 URL 取自启动图里自己的那一行），worker 只负责把「点了哪个按钮 / 点了正文」
转回页面。普通浏览器在 `http://127.0.0.1` 与 `https` 下可用；用不了 worker 的环境
（局域网 http、**DSH 桌面端**——`dsh-app://` 注册不了 Service Worker）退回不带按钮
的普通通知，并在设置页「系统弹窗」行下如实说明。`__dshTaskReminder.state().approvalBridge`
为 `active` 就是按钮可用；`__dshTaskReminder.test('approval')` 可以给自己发一条带按钮
的测试通知（点按钮只回一条测试反馈，不裁决任何真实请求）。

一个作用域上的注意点：所有 DSH 客户端 bundle 都从同一个 `/plugins/` 路由发出，
所以注册落在共享的 `/plugins/` 作用域上——同一个 Origin 只能有一个这样的 worker。
**同类通知插件只装一个**：如果还装着另一个用同一招的插件（例如 `dsh-notify-me`），
两次注册会互相顶替，只有一个插件的通知按钮能继续用；两个都装还会让每次停止提醒两遍。

### 自定义音效（用你自己的音频）

「设置 → 任务提醒 → 自定义音效 → 选择文件」接受本机音频（mp3 / wav / ogg / m4a
等浏览器能解码的格式，上限 5 MB）。插件把它存进 **IndexedDB** 的
`dsh.task-reminder` 库（本地存储那点配额装不下音频，而且是同步写），解码成
`AudioBuffer`，把音效切到「自定义」并当场按当前音量试听一次。之后每次提醒都用
同一个音量增益播放这个文件，首尾各 10ms 淡入淡出，避免硬切的文件爆音。

音频不出本机：不上传、不进 npm 包，宿主半侧完全不参与。它按浏览器 Origin 存在
本地，重启后仍在，但「清除站点数据」或换浏览器就没了——那时重新选一次即可，行内
会如实提示文件已丢失。点「清除」会删掉存储的字节并把音效切回第一种合成音效。
存不下或解不开（隐私模式、配额满、编码不支持）时，行内直接说明原因，提醒回落到
合成音效。

### 浏览器控制台助手

在浏览器 DevTools 控制台里：

```js
// 前台状态、八个配置、通知语言、审批按钮桥状态、弹窗时机、通知权限、自定义音效状态、各会话 running、
// 三条通道的计数、重复抑制次数、最近几条停止与最近一次各类停止、未结清的等待通知、
// 点弹窗抬窗的留痕（stats.lastActivation）
__dshTaskReminder.state()

// 当场发一条「任务完成」弹窗并放一声（不等任务停止）
__dshTaskReminder.test()
__dshTaskReminder.test('question')   // 「提问」弹窗
__dshTaskReminder.test('approval')   // 真的带「同意 / 拒绝」按钮的审批通知：
                                     // 点任一个按钮，只回一条测试反馈，不裁决任何真实请求
__dshTaskReminder.test('error')      // 「任务出错已停止」弹窗

// 只按当前音效与音量放音
__dshTaskReminder.sound()

// 不点弹窗，当场对当前打开的会话再跑一次「落到你这次提问的位置」
// （DSH 升级后想确认这步还好用时就跑它）
__dshTaskReminder.focusQuestion()

// 一行看清上次落到哪一步，以及这步依赖的 DSH DOM 实况
// （会话流列 / 你的消息行 / 滚动口的条数与几何）
__dshTaskReminder.report()

// 「检查更新」那一行现在处在哪一格（相位 / 版本 / 失败原因）：
// 点完按钮再看这里，就知道那次检查走到哪一步
__dshTaskReminder.state().update
```

### 桌面端（DSH Desktop）：点弹窗把窗口拉回前台

桌面端（Electron）里弹窗行为完全一样，只多一步「只有宿主半侧做得到」的动作。
安装命令见[安装](#-安装)：`dsh plugin --profile desktop add @hawkongz/dsh-task-reminder`，
其余提醒行为与 Web 端一致。
渲染进程拉不起被 Windows 最小化、或被 DSH 收进托盘的窗口：`window.focus()` 对
这种窗口无效，只有主进程的 `focusPrimaryWindow()`（`restore()` → `show()` →
`focus()`）能拉起来——它能被托盘点击和「再启动一份应用」（`dsh://open`，走
`second-instance`）触发，而插件页面既没有那条 IPC，也发不出外部协议。

所以点击弹窗时页面会 `POST api/task-reminder/window-activation`（宿主半侧注册的
Connection 精确 Fetch 路由，与普通 RPC 共用 `/api` 通道和 cookie 认证），宿主半侧
随即再启动一份应用：新进程拿不到单实例锁、立刻退出，正在跑的那份把窗口拉到前台。
页面只认「确实在桌面端」（`'dshDesktop' in window`）这一个前提，**每次点击都发**：
不按 `document.hasFocus()` 短路——Electron 里窗口只是被挡住 / 藏起来时它仍可能报
true，按它跳过就等于永远唤不起。宿主那边按 0 / 700 / 2200ms 补发，在「直起 exe」
与「PowerShell 强抢前台」（`AttachThreadInput` + `SetForegroundWindow`，绕开 Windows
的前台锁）之间轮换，但**确认窗口已在前台就立刻收手**：助手退出码 0 就是「收尾时目标
窗口已经是前台」，拿到这个信号剩下的补发全部作废；助手动手前也会自己先看一眼，已经
在前台就不抢（最小化的不算，照样 restore）。所以成功的那次点击最多打扰 0.7 秒，而不是在
4 秒里抢五次前台——上一版那条无条件的补发梯子会把已经切去别的应用的用户一遍遍拽回来。
普通浏览器、没有这张路由表的 DSH 组合、或请求失败，都是安静的空操作——「打开对应
会话」这条主路径永远不受影响。macOS 走 `open dsh://open`，其他平台跳过。

另外两条与之相关的行为：等待类通知（提问 / 方案待确认 / 退回普通样式的审批）在
挂起消散（已回答 / 交互关闭 / 会话消失）时**当场收掉**，不在通知中心留「点了也
再也没有对应等待」的陈旧条目；点通知抬窗的每个去路都记一笔留痕，复现「点了却
没抬窗」时读它就知道断在哪一步：

```js
// { at, route, reason, status?, error? }
// reason: no-desktop / no-fetch / sent / answered / failed / error
__dshTaskReminder.state().stats.lastActivation
```

未结清的等待通知所在会话列在 `__dshTaskReminder.state().waitingToasts`（正常很
快清空；有常驻条目就说明有通知没收掉）。

### 自检

```bash
npm test                 # 三套都跑：契约 + 两半
node test/verify-contract.mjs
node test/verify-client.mjs
node test/verify-host.mjs
```

`test/verify-contract.mjs` 把两半放进同一个进程对拍：包名、三条路由（宿主侧的绝对
路径 vs 桌面壳里页面必须用的相对形式）、版本号，再把宿主的 `checkUpdate` /
`applyUpdate` 真实答复喂进渲染侧的状态机 —— 一侧改名不会再「两边都绿」地漂移。

用桩服务跑浏览器半侧（不需要浏览器），断言模块身份、接线、边沿判定、三条通道
去重与重复边沿抑制、未闭合回合不误报完成、两种弹窗时机、三种停止原因（完成
/ 等你回答 / 出错）与「一次停止只报一次：turn/end 分类 + 晚到错误撤回」的对账、
回合号判据（同一个 turn 的重复边沿在 5 秒窗口过期、票据被陈旧回放清掉后仍只报
一条；新 turn 在上一轮停止 5 秒内完成照报；同一个 turn 的 error 与 completion
不会各报一次；边沿风暴下每个 turn 恰好一条弹窗）、提示音每次停止都响（与窗口状态无关）、
子智能体过滤（默认关时三种停止都不报、开关打开后三种都恢复、fork 会话不受影响）、
八个配置的默认值 / 读 / 写 / 恢复默认、弹窗时机两档的说明（两行都渲染在标题下面、
一档一行，且文案就是指定的那两句）、每种音效与音量对应的振荡器参数、自定义
音效路径（IndexedDB 存取、`decodeAudioData` 解码后按音量播放、解码或存储失败时
回落合成音、下次装载从 IndexedDB 恢复）、系统通知的
权限路径与设置页里的「申请通知权限」按钮、桌面端唤醒窗口的请求（只在桌面端、
只在窗口不在前台时发出）、点弹窗后的落点（在会话流列里找到你自己的最后一条消息、
跳过 hidden 行、滚动口取 `[data-conversation-scroll]` 或列的父节点、把行对到顶部下方
24px、复查到坐稳为止、到顶 / 到底时不写、认不出列 / 提问 / 滚动口就到上限收工并记下
结果），挂起 AudioContext 的手势拉活，**检查更新那一行**（含预发布的版本比较、
它可能处在的每一格 —— 已最新 / 有新版 / 本地开发安装 / 没有插件管理服务 / 失败 ——
这一行确实排在页面最后，以及检查与更新两次宿主往返的 POST 内容），以及资源回收。

`test/verify-host.mjs` 用桩 `fetch` / 桩 `profileContext` / 桩 `pluginManager` 跑宿主
半侧自己的逻辑：源查询（两个源都问、取更高的答案、一个挂掉仍能用另一个、两个都不通
时如实报失败）、拒绝路径（`link:` 安装、没有 `pluginManager` 的组合）、传给
`installBundle` 的到底是什么、失败诊断，以及三条 Connection 路由（唤醒窗口 / 检查
更新 / 立即更新）都以 `POST` 注册在各自的路径上。

## 🔧 常见问题

* **设置页不见了。** 插件在 `dsh.client.inject` 里声明了
  `@deepseek-ai/dsh-client-ui-settings`；确认安装完整后重启 `dsh web` 并硬刷新。
  还是没有，就把安装命令原样再跑一遍：
  `dsh plugin --profile web add @hawkongz/dsh-task-reminder`。
* **刚发的版本装不上（装完还是上一版）。** pnpm 11 默认 `minimumReleaseAge`
  为 1440 分钟（1 天），比它更年轻的版本解析不到：
  `dsh plugin … add @hawkongz/dsh-task-reminder` 会打出
  `… 1.6.1 (1.6.2 is available)` 并装上上一版。钉版本
  （`… add @hawkongz/dsh-task-reminder@1.6.2`）、在 profile 的
  `pnpm-workspace.yaml` 里设 `minimumReleaseAge: 0`，或者等满一天，都能解决。
* **改了代码没生效。** 宿主只在进程启动时读客户端产物，浏览器又会缓存旧 bundle。
  重启 `dsh web`，再硬刷新（`Ctrl + F5`）。
* **系统弹窗不弹。** 按顺序查链路：
  1. `__dshTaskReminder.state()`：`notificationSupported` 必须为 `true`、
     `notificationPermission` 必须为 `granted`，且每次完成后
     `stats.notifications` 要往上加（是 `1` 就说明浏览器接受了 toast，剩下的
     丢失在系统展示层，不是插件的问题）。
  2. 权限还是 `default`？设置页「系统弹窗」行下有「申请通知权限」按钮，点一次
     再选「允许」；是 `denied`？这一档**故意不提供按钮**（不给被拒的站点反复弹框）：
     去浏览器地址栏的站点权限里允许通知，权限一变成 `granted` 提示就消失；
     把该站点的通知权限改回「询问（Ask）」则按钮会重新出现。权限按 Origin 共享：
     本站点授权一次，所有插件通用。
  3. 浏览器接受了但屏幕上没有？那是 Windows 在压浏览器 toast。查：设置 → 系统 →
     通知（总开关**和**「浏览器」这一项的应用开关）、专注助手设为「关」
     （「仅优先级」会压掉普通 toast），并按 `Win + N` 打开通知中心看看——toast
     可能已经躺在那儿只是没注意到。
  4. 十秒隔离测试：在页面控制台执行 `new Notification('DSH 测试', { body: '能看到
     我吗' })`。这条也没有 toast，就是 Windows/浏览器在压，任何插件代码都绕不过。
* **全屏看视频 / 玩游戏时不弹横幅，退出全屏也不补弹？** 这是 Windows，而且有开关：
  前台有全屏应用时 Windows 会隐藏通知横幅——**连优先级通知一起隐藏**——提醒只会进
  通知中心（`Win + N`），被压掉的横幅退出全屏后也不会重放。开关在：设置 → 系统 →
  通知 →「请勿打扰」→「**在全屏模式下使用应用时（优先级通知横幅也会隐藏）**」，
  关掉它横幅就会盖在全屏窗口上。已在 Windows 11（build 26200）上核实：开着时这条
  规则把全屏绑到「仅限闹钟」档，连你加进优先名单的应用也不放行；关掉后绑定消失，
  弹窗恢复正常。插件侧绕不过这件事（Web Notification 没有绕过「请勿打扰」的接口），
  但提示音照常响，弹窗也一直躺在通知中心里。
* **提示音没声。** 音量可能是 `0`，标签页可能被静音，或者浏览器的自动播放策略在
  你的第一次交互之前拦住了 AudioContext——在页面上任意点一下/按个键，之后就能响。
* **一个浏览会话的第一声提示音会慢几秒。** Chrome 的首次音频渲染会启动操作系统
  音频设备（某些 Windows 机器上要 3-5 秒），而自动播放策略只允许从用户手势触发这次
  启动——页内代码无法在手势之前出声，所有网站都付这笔钱。规避习惯：打开页面后先在
  页面里任意点一下（第一个手势负责把 context 拉活；那条听不见的预热音在装载时就已
  排上，设备有整页加载的时间去启动），等你去切
  音效或任务完成时，设备已经热了，提示音即时。
* **明明在看着对话，还是弹窗。** 这是「任何情况都弹」时机的本职。把设置页「弹窗
  时机」切到「仅非前台窗口」，就只在切走标签页或浏览器窗口失焦时才弹。
* **DSH 桌面端：点了弹窗会话开了，但窗口没自己回来。** 「拉窗口回前台」是 1.4.4
  才加的宿主半侧行为，而宿主只在进程启动时读插件——还在跑的应用拿的是旧
  `index.js`。先确认 profile 里是 1.6.2 或更新（有这条路由的最低版本是 1.4.4）
  （`dsh --profile desktop --dump-config | Select-String task-reminder`），然后
  彻底退出应用再打开。路由不存在时静默跳过是设计如此：会话照样打开，只是窗口
  不会被拉起。

## 📌 标签

[`dsh`](https://github.com/topics/dsh) [`deepseek-harness`](https://github.com/topics/deepseek-harness) [`cordis`](https://github.com/topics/cordis) [`cordis-plugin`](https://github.com/topics/cordis-plugin) [`web-ui`](https://github.com/topics/web-ui) [`notification`](https://github.com/topics/notification) [`reminder`](https://github.com/topics/reminder) [`web-audio`](https://github.com/topics/web-audio)

## 🤝 贡献指南

见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 📄 许可证

基于 [MIT](../LICENSE) 协议开源。
