<div align="center">
  <h1>dsh-task-reminder</h1>
  <p>DeepSeek Harness Web 的对话任务完成提醒插件</p>

  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../LICENSE)
  [![Platform](https://img.shields.io/badge/Platform-DeepSeek%20Harness-lightgrey)](https://github.com/deepseek-ai)
  [![Stars](https://img.shields.io/github/stars/hawkongz/dsh-task-reminder)](https://github.com/hawkongz/dsh-task-reminder/stargazers)

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
右下角的原生通知，浏览器退到后台也看得到；点它回到该会话），并响一声合成提示音。
三种停止原因都覆盖：**任务完成**、**Agent 抛出问题等你回答**（ask_user_question /
计划评审挂起——只读 uiSession.sessionStatus 快照的出现边沿，不碰问答应答链）、
**出错停止**（api-session/error——任何让回合失败的错误：网关 HTTP 错误如 400 / 401 / 429 / 500 / 502、服务商故障、连接失败）。同一次停止只报一次（错误
优先：停止到达时按会话持久日志里 `turn/end` 的原因分类——completed（含 max-tokens 截断）报完成，error 只报错误、正文是网关原文、不出现完成弹窗，取消（aborted）不报；读取时同时取最后一条 turn/start，最新回合未闭合（读到的是上一回合的 turn/end）时重试等它落盘，点停止不会误报完成；提示音与弹窗在同一次处理里发出。分类不可用时完成弹窗先发，5 秒内后到的同停止错误会撤回它，只留错误。同一次停止的重复边沿（分类在途时列表陈旧回放）由在途守卫与完成→完成去重双兜底，不会双弹）。弹窗时机二选一：
**「任何情况都弹」**（不管浏览器窗口是否在前台，每次停止都弹）或 **「仅非前台
窗口」**（切走标签页或浏览器窗口失焦、人在别的应用时才弹）。没有应用内卡片——
系统弹窗是唯一的视觉通道。所有配置都在独立设置页里完成，并持久化到重启之后。

提醒逻辑全在浏览器半侧——宿主半侧（`index.js`）只多做一件事，而且只在 DSH
桌面端（DSH Desktop）里做：**点弹窗时把应用窗口拉回前台**。Electron 的渲染进程
拉不起已被最小化或收进托盘的窗口，所以点击弹窗时页面会请宿主半侧（`POST`
`api/task-reminder/window-activation`，一条 Connection 精确 Fetch 路由）再启动
一份应用：第二份拿不到单实例锁、立刻退出，第一份随即走
`second-instance` → `focusPrimaryWindow()`。运行时零依赖，桌面端之外宿主半侧
等于不存在。

## ✨ 功能特性

* **Windows 系统弹窗，唯一视觉通道：** 走 Web Notification API，以操作系统 toast
  的形式弹出，应用退到后台也看得到；点击弹窗窗口回前台并打开对应会话——浏览器里
  `window.focus()` 就够，DSH 桌面端里由宿主半侧把最小化 / 收进托盘的窗口拉起来
  （见[桌面端（DSH Desktop）](#桌面端dsh-desktop点弹窗把窗口拉回前台)）。三种停止
  原因都覆盖：**任务完成**、**等你回答**（Agent 阻塞在 ask_user_question / 计划
  评审——只读 `uiSession.sessionStatus` 快照的出现边沿，绝不参与 user-questions
  应答链）、**出错停止**（`api-session/error`——任何让回合失败的错误：网关 HTTP 错误如 400 / 401 / 429 / 500 / 502、服务商故障、连接失败）。同一次停止
  只报一次、错误优先：停止到达时读会话持久日志最后一条 `turn/end` 的 reason 分类——completed / max-tokens 报完成，error 只报错误（正文取网关原文），aborted / blocked / interrupted 不报；读时同时取最后一条 turn/start，最新回合未闭合时重试等本次回合的 turn/end 落盘（取消不误报完成）；提示音与弹窗同轮发出。分类读不到才退回完成弹窗，5 秒内后到的同停止错误会撤回它只留错误（一次停止一次提醒）；重复边沿（分类在途时列表陈旧回放）由在途守卫与完成→完成去重双兜底，只报一次。
  时机二选一：**「任何情况都弹」**（每次停止都弹，不管窗口在不在前台）与
  **「仅非前台窗口」**（切走标签页或浏览器窗口失焦时才弹），设置页里切换。首次
  装载时代码会替用户申请一次权限（浏览器的 Notification API 没有免权限通道——
  只在页面内画东西的插件才不需要这一步；权限按 Origin 共享，本站点授权一次，
  所有插件通用）；之后权限若被重置，设置页「系统弹窗」行下的「申请通知权限」
  按钮可以再申请。被拒绝或不支持时，设置页给出明确提示，而不是假装生效。
* **四种合成提示音：** 两声（经典）、三声上扬、上升琶音、圆润三角波——全部用
  Web Audio 现场生成，不带任何音频文件。点选音效立即按当前音量发声，没有多余
  的「试听」按钮。提示音不管窗口在不在前台，每次停止都响。
* **独立设置页：** 「设置 → 任务提醒」（「设置 → 通用」里不再占行），一键恢复
  默认。
* **三通道完成检测、天然去重：** 宿主转发事件 `api-session/status`、官方会话
  列表自身的 `running` 位、以及 `uiSession.sessionStatus` 快照里的 `running` 位
  （与 sidebar 运行指示灯同源；fork 子会话的列表投影不可靠——陈旧 / 不翻——
  时这条路仍可靠）共用一张边沿表，一次完成绝不会提醒两遍；分类在途时的重复
  边沿另由在途守卫与完成→完成去重兜底。
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
`dsh-taskreminder` 过于相似、永久拒发，所以 registry 形式只能带 scope。）

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

记住重启规则：改 `client.js` → 跑 `node test/verify-client.mjs` → 重启
`dsh web` → 硬刷新浏览器——宿主不会热读改过的 `client.js`。

## 📖 使用方法

### 设置页

「设置 → 任务提醒」（设置导航 order 44）：

| 设置项 | 默认 | 持久化键 |
| :--- | :--- | :--- |
| 系统弹窗 | 开 | `dsh.task-reminder.notify` |
| 弹窗时机（任何情况都弹 / 仅非前台窗口） | 任何情况都弹 | `dsh.task-reminder.notify-mode` |
| 完成提示音 | 开 | `dsh.task-reminder.sound` |
| 提示音音效（四种） | 第一种（两声·经典） | `dsh.task-reminder.sound-choice` |
| 提示音音量（0–100） | 80 | `dsh.task-reminder.volume` |

「恢复默认」一键写回：弹窗开（任何情况都弹）、提示音开、第一种音效、音量 80。

### 浏览器控制台助手

在浏览器 DevTools 控制台里：

```js
// 前台状态、五个配置、弹窗时机、通知权限、各会话 running、
// 三条通道的计数、重复抑制次数、最近几条停止与最近一次各类停止
__dshTaskReminder.state()

// 当场发一条「任务完成」弹窗并放一声（不等任务停止）
__dshTaskReminder.test()

// 只按当前音效与音量放音
__dshTaskReminder.sound()
```

### 桌面端（DSH Desktop）：点弹窗把窗口拉回前台

桌面端（Electron）里弹窗行为完全一样，只多一步「只有宿主半侧做得到」的动作。
渲染进程拉不起被 Windows 最小化、或被 DSH 收进托盘的窗口：`window.focus()` 对
这种窗口无效，只有主进程的 `focusPrimaryWindow()`（`restore()` → `show()` →
`focus()`）能拉起来——它能被托盘点击和「再启动一份应用」（`dsh://open`，走
`second-instance`）触发，而插件页面既没有那条 IPC，也发不出外部协议。

所以点击弹窗时页面会 `POST api/task-reminder/window-activation`（宿主半侧注册的
Connection 精确 Fetch 路由，与普通 RPC 共用 `/api` 通道和 cookie 认证），宿主半侧
随即再启动一份应用：新进程拿不到单实例锁、立刻退出，正在跑的那份把窗口拉到前台。
只有页面确实在桌面端（`'dshDesktop' in window`）**且**窗口不在前台时才发这个请求；
普通浏览器、没有这张路由表的 DSH 组合、或请求失败，都是安静的空操作——「打开对应
会话」这条主路径永远不受影响。macOS 走 `open dsh://open`，其他平台跳过。

### 自检

```bash
node test/verify-client.mjs
```

用桩服务跑浏览器半侧（不需要浏览器），断言模块身份、接线、边沿判定、三条通道
去重与重复边沿抑制、未闭合回合不误报完成、两种弹窗时机、三种停止原因（完成
/ 等你回答 / 出错）与「一次停止只报一次：turn/end 分类 + 晚到错误撤回」的对账、提示音每次停止都响（与窗口状态无关）、
五个配置的默认值 / 读 / 写 / 恢复默认、每种音效与音量对应的振荡器参数、系统通知的
权限路径与设置页里的「申请通知权限」按钮、桌面端唤醒窗口的请求（只在桌面端、
只在窗口不在前台时发出）、挂起 AudioContext 的手势拉活，以及资源回收。

## 🔧 常见问题

* **设置页不见了。** 插件在 `dsh.client.inject` 里声明了
  `@deepseek-ai/dsh-client-ui-settings`；确认安装完整后重启 `dsh web` 并硬刷新。
  还是没有，就把安装命令原样再跑一遍：
  `dsh plugin --profile web add @hawkongz/dsh-task-reminder`。
* **改了代码没生效。** 宿主只在进程启动时读客户端产物，浏览器又会缓存旧 bundle。
  重启 `dsh web`，再硬刷新（`Ctrl + F5`）。
* **系统弹窗不弹。** 按顺序查链路：
  1. `__dshTaskReminder.state()`：`notificationSupported` 必须为 `true`、
     `notificationPermission` 必须为 `granted`，且每次完成后
     `stats.notifications` 要往上加（是 `1` 就说明浏览器接受了 toast，剩下的
     丢失在系统展示层，不是插件的问题）。
  2. 权限还是 `default`？设置页「系统弹窗」行下有「申请通知权限」按钮，点一次
     再选「允许」；是 `denied`？去浏览器地址栏的站点权限里允许通知，再点一次
     那个按钮。权限按 Origin 共享：本站点授权一次，所有插件通用。
  3. 浏览器接受了但屏幕上没有？那是 Windows 在压浏览器 toast。查：设置 → 系统 →
     通知（总开关**和**「浏览器」这一项的应用开关）、专注助手设为「关」
     （「仅优先级」会压掉普通 toast），并按 `Win + N` 打开通知中心看看——toast
     可能已经躺在那儿只是没注意到。
  4. 十秒隔离测试：在页面控制台执行 `new Notification('DSH 测试', { body: '能看到
     我吗' })`。这条也没有 toast，就是 Windows/浏览器在压，任何插件代码都绕不过。
* **提示音没声。** 音量可能是 `0`，标签页可能被静音，或者浏览器的自动播放策略在
  你的第一次交互之前拦住了 AudioContext——在页面上任意点一下/按个键，之后就能响。
* **一个浏览会话的第一声提示音会慢几秒。** Chrome 的首次音频渲染会启动操作系统
  音频设备（某些 Windows 机器上要 3-5 秒），而自动播放策略只允许从用户手势触发这次
  启动——页内代码无法在手势之前出声，所有网站都付这笔钱。规避习惯：打开页面后先在
  页面里任意点一下（插件会在第一个手势上 resume 并播一条听不见的预热音），等你去切
  音效或任务完成时，设备已经热了，提示音即时。
* **明明在看着对话，还是弹窗。** 这是「任何情况都弹」时机的本职。把设置页「弹窗
  时机」切到「仅非前台窗口」，就只在切走标签页或浏览器窗口失焦时才弹。
* **DSH 桌面端：点了弹窗会话开了，但窗口没自己回来。** 「拉窗口回前台」是 1.4.4
  才加的宿主半侧行为，而宿主只在进程启动时读插件——还在跑的应用拿的是旧
  `index.js`。先确认 profile 里是 1.4.4
  （`dsh --profile desktop --dump-config | Select-String task-reminder`），然后
  彻底退出应用再打开。路由不存在时静默跳过是设计如此：会话照样打开，只是窗口
  不会被拉起。

## 📌 标签

[`dsh`](https://github.com/topics/dsh) [`deepseek-harness`](https://github.com/topics/deepseek-harness) [`cordis`](https://github.com/topics/cordis) [`cordis-plugin`](https://github.com/topics/cordis-plugin) [`web-ui`](https://github.com/topics/web-ui) [`notification`](https://github.com/topics/notification) [`reminder`](https://github.com/topics/reminder) [`web-audio`](https://github.com/topics/web-audio)

## 🤝 贡献指南

见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 📄 许可证

基于 [MIT](../LICENSE) 协议开源。
