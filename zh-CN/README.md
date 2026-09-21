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

当一轮对话任务在**你没盯着对话窗口**时结束，插件用三种方式提醒：系统通知发不出去时
兜底的右下角提醒卡、每次完成都响的提示音，以及一条浏览器退到后台也能看到的
系统通知。所有配置都在独立设置页里完成，并持久化到重启之后。

整个插件都在浏览器半侧：宿主半侧（`index.js`）是一个空的 `apply() {}`，
运行时零依赖——宿主只是把它作为客户端插件发给页面。

## ✨ 功能特性

* **兜底提醒卡：** 系统通知发不出去时（权限没给，或浏览器不支持 Notification
  API），右下角（距边 8 px）弹卡显示会话名，点「查看」直接跳回该会话。宽度
  （240–640 px）与高度（0–400 px，`0` 为自动）都可调，设置页里还有一张实时
  联动的样例卡。
* **四种合成提示音：** 两声（经典）、三声上扬、上升琶音、圆润三角波——全部用
  Web Audio 现场生成，不带任何音频文件。点选音效立即按当前音量发声，没有多余
  的「试听」按钮。
* **系统通知默认开启：** 走 Web Notification API，以操作系统 toast 的形式弹出，
  应用退到后台也看得到；点击通知窗口回前台并打开对应会话。浏览器权限借设置页
  开关这个用户手势申请；被拒绝或不支持时，设置页给出明确提示，而不是假装生效。
* **独立设置页：** 「设置 → 任务提醒」（「设置 → 通用」里不再占行），一键恢复
  默认。
* **按在场状态静默（只影响卡与通知）：** 只有「主区是对话窗口 + 标签页可见 +
  窗口有焦点」三者同时成立，卡片与系统通知才保持安静。切到别的面板、切走标签页、
  焦点转到别的应用，都算人不在——该提醒就提醒。提示音不管在不在，每次完成都响。
* **双通道完成检测、天然去重：** 宿主转发事件 `api-session/status` 与官方会话
  列表自身的 `running` 位共用一张边沿表，一次完成绝不会提醒两遍。
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
dsh plugin --profile web add github:hawkongz/dsh-task-reminder
```

```bash
# macOS / Linux
dsh plugin --profile web add github:hawkongz/dsh-task-reminder
```

想装指定版本而不是默认分支，就带上标签：
`dsh plugin --profile web add github:hawkongz/dsh-task-reminder#v1.2.1`。
等这个包发布到 npm registry 之后， bare 包名同样可用：
`dsh plugin --profile web add dsh-task-reminder`。

**第三步 — 重启并验证**

重启宿主（`dsh web`），再硬刷新浏览器（`Ctrl + F5`）。改过 `client.js` 之后
浏览器不会热读，所以每次更新这两步都省不掉。验证登记结果：

```powershell
dsh --profile web --dump-config | Select-String task-reminder
```

> **完成。** 打开「设置 → 任务提醒」：页面在，插件就活了。随便找个会话跑一个
> 任务，切到别的应用，等着收提醒。

## 📦 安装

### 前置条件

* 跑着 `web` profile 的 DeepSeek Harness（`dsh web`）。
* `PATH` 上有 pnpm——`dsh plugin` 会把参数原样转给 profile 目录里的 pnpm。
* Node.js 20 或更高（自检要用）。
* 支持 Web Audio、最好也支持 Notification API 的浏览器。

### 用 dsh plugin 安装

```powershell
dsh plugin --profile web add github:hawkongz/dsh-task-reminder
```

一条命令同时做两件事：把包装进 profile，以及把 `dsh-task-reminder` 追加进
profile 的 `dsh.profile.bundles`；随后加载器应用 bundle 自带的
`cordis.patch.yml`，插入 `task-reminder` 行。本包不带任何构建脚本，pnpm 不会
拦住安装（那类需要在 profile 的 `pnpm-workspace.yaml` 里加 `allowBuilds`
的情况只发生在带 prepare 脚本的 git 托管包上）。

包里带着插件需要的全部文件：`index.js`（宿主半侧）、`client.js`（浏览器半侧）、
`cordis.patch.yml`（bundle 行），以及 `test/` 下的自检脚本。

### 卸载

```powershell
dsh plugin --profile web remove dsh-task-reminder
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
| 系统通知 | 开 | `dsh.task-reminder.notify` |
| 完成提示音 | 开 | `dsh.task-reminder.sound` |
| 提示音音效（四种） | 第一种（两声·经典） | `dsh.task-reminder.sound-choice` |
| 提示音音量（0–100） | 80 | `dsh.task-reminder.volume` |
| 提醒卡宽度（240–640 px） | 420 | `dsh.task-reminder.width` |
| 提醒卡高度（0–400 px，0 = 自动） | 0 | `dsh.task-reminder.height` |

各行下面是一张跟着宽高实时变化的卡片预览，外加一个「恢复默认」按钮，一键写回：
通知开、提示音开、第一种音效、音量 80、宽 420 px、高自动。

### 浏览器控制台助手

在浏览器 DevTools 控制台里：

```js
// 面板状态、六个配置、通知权限、当前卡片、各会话 running、
// 两条通道的计数与最近一次完成来源
__dshTaskReminder.state()

// 当场弹一张卡并放一声（不等任务完成）
__dshTaskReminder.test()

// 只按当前音效与音量放音
__dshTaskReminder.sound()
```

### 自检

```bash
node test/verify-client.mjs
```

用桩服务跑浏览器半侧（不需要浏览器），断言模块身份、接线、边沿判定、两条通道
去重、卡与通知的在场静默、提示音每次完成都响、六个配置的默认值 / 读 / 写 /
恢复默认、每种音效与音量对应的振荡器参数、卡片与预览样式、系统通知三条权限路径
与设置页里的「申请通知权限」按钮，以及资源回收。

## 🔧 常见问题

* **设置页不见了。** 插件在 `dsh.client.inject` 里声明了
  `@deepseek-ai/dsh-client-ui-settings`；确认安装完整后重启 `dsh web` 并硬刷新。
  还是没有，就把安装命令原样再跑一遍：
  `dsh plugin --profile web add github:hawkongz/dsh-task-reminder`。
* **改了代码没生效。** 宿主只在进程启动时读客户端产物，浏览器又会缓存旧 bundle。
  重启 `dsh web`，再硬刷新（`Ctrl + F5`）。
* **系统通知不弹。** 看 `__dshTaskReminder.state()`：`notificationSupported`
  必须为 `true`、`notificationPermission` 必须为 `granted`。权限还是
  `default`（从没问过）时，设置页里有「申请通知权限」按钮，点一次再选
  「允许」即可；如果是 `denied`，去浏览器地址栏的站点权限里允许通知，
  再点一次那个按钮。
* **提示音没声。** 音量可能是 `0`，或者浏览器的自动播放策略在你的第一次交互
  之前拦住了 AudioContext。在页面上任意点一下，之后就能响。
* **明明在看着对话，还是弹提醒。** 静默要三个条件同时成立：主区是对话窗口、
  标签页可见、窗口有焦点。万一没拿到面板钩子，插件会在控制台 warn 一次，并按
  「人不在」处理——这是有意为之，不静默失效。

## 📌 标签

[`dsh`](https://github.com/topics/dsh) [`deepseek-harness`](https://github.com/topics/deepseek-harness) [`cordis`](https://github.com/topics/cordis) [`cordis-plugin`](https://github.com/topics/cordis-plugin) [`web-ui`](https://github.com/topics/web-ui) [`notification`](https://github.com/topics/notification) [`reminder`](https://github.com/topics/reminder) [`web-audio`](https://github.com/topics/web-audio)

## 🤝 贡献指南

见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 📄 许可证

基于 [MIT](../LICENSE) 协议开源。
