<div align="center">
  <h1>dsh-task-reminder</h1>
  <p>任务跑完了，不用再盯着侧边栏那盏灯<br/>DeepSeek Harness（Web 与桌面端）的对话任务提醒：一条 Windows 系统弹窗 + 一声提示音</p>

  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
  [![Platform](https://img.shields.io/badge/Platform-DeepSeek%20Harness-lightgrey)](https://github.com/deepseek-ai)
  [![Stars](https://img.shields.io/github/stars/hawkongz/dsh-task-reminder)](https://github.com/hawkongz/dsh-task-reminder/stargazers)
  [![npm](https://img.shields.io/npm/v/@hawkongz/dsh-task-reminder)](https://www.npmjs.com/package/@hawkongz/dsh-task-reminder)
  [![下载量](https://img.shields.io/npm/dt/@hawkongz/dsh-task-reminder?label=%E4%B8%8B%E8%BD%BD%E9%87%8F)](https://www.npmjs.com/package/@hawkongz/dsh-task-reminder)

  <p><strong>语言：</strong> 简体中文 | <a href="README.en.md">English</a></p>
</div>

---

## 目录

- [这是什么](#这是什么)
- [30 秒上手](#30-秒上手)
- [你会看到什么](#你会看到什么)
- [设置一览](#设置一览)
- [桌面端（DSH Desktop）](#桌面端dsh-desktop)
- [常见问题](#常见问题)
- [进阶](#进阶)
- [安装细节](#安装细节)
- [开发与相关文档](#开发与相关文档)
- [许可证](#许可证)

---

## 这是什么

Agent 在 DeepSeek Harness 里跑一个回合常常要好几分钟。这期间你切去别的窗口做事，任务停止的唯一信号就是侧边栏里那盏运行灯灭了——而它不告诉你任务是好端端跑完、还是出错停了；更不会告诉你**Agent 正卡在一个问题上等你回答**，你不切回去，它就一直在那儿等。

这个插件把这一刻变成一条真正的提醒：任务一停止，立刻发一条 **Windows 系统弹窗**（就是操作系统右下角的原生通知，浏览器退到后台也看得见），同时响一声合成提示音。点一下弹窗就回到那个会话，**并落在你这次提问的位置**——接着往下读就行。

三种停止原因都覆盖，而且**一次停止只提醒一次、错误优先**：完成通知不会和出错通知打架，你手点的「停止」也不会被误报成「任务完成」。所有设置都在自己的设置页里，改完自动保存，重启后仍在。

零运行时依赖：提醒逻辑全部跑在浏览器半侧，宿主半侧只多做两件页面做不到的事（桌面端点通知把窗口拉回前台、以及设置页里的检查更新）。为什么要这样做、边界情况怎么处理，写在 [docs/how-it-works.md](docs/how-it-works.md)。

## 30 秒上手

> **需要什么：** 跑着 `web` profile 的 DeepSeek Harness（`dsh web`）、`PATH` 上有 pnpm（`dsh plugin` 会把参数转给它）、一个能硬刷新的浏览器。

**第一步：装**

```powershell
# Windows（PowerShell），任意目录执行
dsh plugin --profile web add @hawkongz/dsh-task-reminder
```

```bash
# macOS / Linux
dsh plugin --profile web add @hawkongz/dsh-task-reminder
```

**第二步：重启宿主，再硬刷新浏览器**

```bash
dsh web
```

改过插件之后这两步都省不掉：宿主只在启动时读插件，浏览器又会缓存旧文件。

**第三步：允许通知**

打开「设置 → 任务提醒」——页面在，插件就活了。首次装载浏览器会问一次通知权限，选**允许**；当时错过了也不要紧，点「系统弹窗」这一行下面的**申请通知权限**按钮可以再问一次。

随便找个会话跑个任务，等着收提醒就行：默认「任何情况都弹」，哪怕你正盯着对话窗口，通知也会出现。

**桌面端**（DSH Desktop，Electron）把 `web` 换成 `desktop`，装完彻底退出并重开应用（桌面端没有硬刷新那一步）：

```powershell
dsh plugin --profile desktop add @hawkongz/dsh-task-reminder
```

## 你会看到什么

### 任务完成

标题 **对话任务已完成**，正文是这个会话的名字。点通知回到会话，落在你这次提问的位置。

![真实的「对话任务已完成」系统通知](https://raw.githubusercontent.com/hawkongz/dsh-task-reminder/main/docs/images/toast-completed.png)

<sub>真实弹窗（DSH Desktop，深色主题）：应用名、标题、正文都在这一条里。</sub>

### Agent 停下来等你

Agent 卡住等你的时候，通知标题会按它等的是什么分开：

| 它在等你做什么 | 通知标题 |
| :--- | :--- |
| 批准一个操作 | **审批请求** |
| 回答一个问题 | **提问** |
| 确认一份方案 | **方案待确认** |
| 认不出具体类型 | **等待你的回答** |

**审批通知上直接带「同意 / 拒绝」两个按钮**（见下图）：点一下就等于审批卡片上的「允许一次 / 拒绝」，不用切回页面；而且在通知上做决定**不会把窗口拽到前台**。这一条需要浏览器的 Service Worker 支持：普通浏览器在 `http://127.0.0.1` 与 `https` 下可用；桌面端（`dsh-app://`）与局域网 http 用不了，审批通知会退回不带按钮的普通样式，设置页会如实说明。

![真实的审批通知：带「同意 / 拒绝」两个按钮](https://raw.githubusercontent.com/hawkongz/dsh-task-reminder/main/docs/images/toast-approval.png)

<sub>真实弹窗（浏览器环境）：审批通知带「同意 / 拒绝」，等于审批卡片的「允许一次 / 拒绝」。</sub>

等待类通知在你回答 / 决定之后会自己收掉，不会在通知中心里留下一条点了没反应的陈旧条目。

### 出错停止

标题 **任务出错已停止**，正文是网关给的原文（例如 `400 Bad Request`）。出错的这一次不会再弹一条「任务完成」。

### 点一下通知

- 打开对应的会话；
- 把**你这次提问**对齐到视口顶部——不是对话底部，这样你接着往下读；
- 桌面端里，窗口若被最小化或收进了托盘，会**先把窗口拉回前台**（见[桌面端](#桌面端dsh-desktop)）。

### 提示音

每次停止都响，跟你选的通知时机无关：四种现场合成的音效（两声·经典 / 三声上扬 / 上升琶音 / 圆润三角波），或者你自己上传的音频文件。

### 一次停止只提醒一次

插件读会话自己的日志判断这次停止是完成、出错还是被取消：重复的信号（同一次停止从不同路径报了两次）会被丢掉，被取消的回合不提醒，出错的回合只报错误。判断过程与各种边界情况写在 [docs/how-it-works.md](docs/how-it-works.md)。

## 设置一览

「设置 → 任务提醒」是一个独立页面：

| 设置项 | 默认 | 说明 |
| :--- | :--- | :--- |
| 系统弹窗 | 开 | 关掉就只有提示音，不再发系统通知 |
| 弹窗时机 | 任何情况都弹 | 另一档是「仅非前台窗口」 |
| 通知语言 | 跟随界面 | 只影响通知文案（标题、正文、按钮），设置页永远跟随界面语言 |
| 子智能体提醒 | 关 | 子代理的停止默认不打扰你；打开后它们的完成 / 等待 / 出错也会提醒 |
| 弹窗一直挂着 | 关 | 打开后横幅不自动收进通知中心，需要你手动点掉 |
| 完成提示音 | 开 | 关掉就完全静音 |
| 提示音音效 | 两声（经典） | 四种合成音效，外加「自定义」（你自己上传的音频） |
| 自定义音效文件 | 无 | 本机音频，存在你自己的浏览器里，不上传 |
| 提示音音量 | 80 | 0–100，0 为静音 |

**恢复默认**一键写回上表默认值；你上传的自定义音效文件会保留，要删就在「自定义音效」那一行点**清除**。

**弹窗时机**的两档：

- **任何情况都弹**（默认）：只要任务停止就弹，不管你是在别的窗口还是正看着对话；
- **仅非前台窗口**：切走了标签页、或者浏览器窗口失焦（人在别的应用里）时才弹。

**子智能体提醒**为什么默认关：lead 派出去的子代理各自在独立会话里跑，一个回合里很容易连着响好几声，而你真正在等的那个对话还在跑。你盯着的那个会话自己会报完成，所以默认关掉不会漏掉你要的信息；fork 出来的会话照旧提醒。想连子代理一起提醒，把这个开关打开即可。

**弹窗一直挂着**为什么存在：Windows 上有一个行为——横幅要是没被点过，那个点击可能永远传不到页面，现场表现就是「点了通知什么都没发生」。打开这个开关，横幅一直挂着等你点，点击就必定送得到；代价是每个通知都得你自己收掉。

![挂着不收的通知](https://raw.githubusercontent.com/hawkongz/dsh-task-reminder/main/docs/images/toast-keep-on-screen.png)

<sub>真实弹窗：一直挂着的通知不会自己收进通知中心，要你亲手点掉。</sub>

## 桌面端（DSH Desktop）

桌面端里提醒行为和浏览器里完全一样，只多一件只有主程序做得到的事：**点通知时把窗口拉回前台**。

页面里的 `window.focus()` 对已经最小化、或者被收进托盘的窗口无效，所以点通知时页面会请宿主半侧代为触发一次应用自身的「唤起窗口」，把窗口 restore 回前台并聚焦。抢前台时它会**确认窗口已经在前台就立刻收手**，不会反复抢：成功的那次点击最多打扰 0.7 秒左右，而不是在几秒里一遍遍把你从别的应用里拽回来；窗口本来就在前台时，它连抢都不抢。

安装命令见 [30 秒上手](#30-秒上手) 里的 `--profile desktop` 一行。

## 常见问题

**通知不弹？** 按从便宜到贵的顺序查：

1. 控制台执行 `__dshTaskReminder.state()`：`notificationSupported` 要是 `true`、`notificationPermission` 要是 `granted`，并且每次完成后 `stats.notifications` 往上加。计数在动，说明浏览器已经收下了这条通知，丢在系统展示层，不是插件的问题。
2. 权限还是 `default`：设置页「系统弹窗」行下有**申请通知权限**按钮，点一次再选允许。已经是 `denied` 的话，这一档故意不给按钮（不反复骚扰已经拒绝的站点）：去浏览器地址栏的站点权限里允许通知即可，权限一变提示就消失；把该站点改回「询问」按钮会重新出现。权限按 Origin 共享，本站点授权一次所有插件通用。
3. 浏览器收下了但屏幕上没有：那是 Windows 在压浏览器通知。查「设置 → 系统 → 通知」（总开关**和**浏览器这一项的应用开关）、「请勿打扰」设为关，再按 `Win + N` 打开通知中心看看——通知可能已经躺在那儿了。
4. 十秒隔离测试：页面控制台执行 `new Notification('DSH 测试', { body: '能看到我吗' })`。这条也不显示，就是 Windows / 浏览器在压，任何插件代码都绕不过。

**全屏看视频 / 玩游戏时不弹横幅，退出全屏也不补弹？** 这是 Windows 的行为，而且有开关：前台有全屏应用时，Windows 会隐藏通知横幅——**连优先级通知一起隐藏**——提醒只进通知中心（`Win + N`），被压掉的横幅退出全屏后也不会重放。开关在「设置 → 系统 → 通知 → 请勿打扰 → 在全屏模式下使用应用时（优先级通知横幅也会隐藏）」，关掉它，横幅就会盖在全屏窗口上。已在 Windows 11（build 26200）实测：开着时这条规则把全屏绑到「仅限闹钟」档，连你加进优先名单的应用也不放行；关掉后弹窗立刻恢复。插件侧绕不过这件事（Web Notification 没有绕过「请勿打扰」的接口），但提示音照常响，通知也一直躺在通知中心里。

**提示音没声。** 音量可能是 0、标签页可能被静音，或者浏览器的自动播放策略在你的第一次交互之前挂起了音频——在页面上任意点一下或者按个键，之后就能响。

**一个浏览会话的第一声提示音会慢几秒。** Chrome 的首次音频渲染要启动系统音频设备（某些 Windows 机器上要 3–5 秒），而自动播放策略只允许从用户手势触发这次启动——所有网站都付这笔钱。规避习惯：打开页面后先在页面里点一下（插件装载时已经排了一条听不见的预热音，设备有整页加载的时间去启动），等你去切音效或者任务完成时，设备已经热了，提示音即时。

**明明在看着对话，还是弹。** 这是「任何情况都弹」时机的本职。把设置页「弹窗时机」切到「仅非前台窗口」，就只在切走标签页或浏览器窗口失焦时才弹。

**审批通知上怎么没有按钮？** 需要 Service Worker：桌面端（`dsh-app://`）与非安全上下文（局域网 http）会退回普通通知。另外所有 DSH 客户端插件共用同一个 `/plugins/` 作用域，**同类通知插件只装一个**——如果还装着另一个用同一招的插件（例如 `dsh-notify-me`），两次注册会互相顶替，只有一个插件的通知按钮还能用；两个都装还会让每次停止提醒两遍。

**点了通知，桌面端窗口没回来。** 「拉窗口回前台」是宿主半侧的行为，而宿主只在进程启动时读插件——还在跑的应用拿的是旧代码。确认 profile 里是 1.6.3 或更新（有这条路由的最低版本是 1.4.4），然后彻底退出应用再打开。路由不存在时是静默跳过：会话照样打开，只是窗口不会被拉起。

**刚发布的版本装不上（装完还是上一版）。** pnpm 11 默认开着「一天冷静期」（`minimumReleaseAge` 为 1440 分钟），比它更年轻的版本解析不到。钉住版本就能装：`dsh plugin --profile web add @hawkongz/dsh-task-reminder@1.6.3`，或者在 profile 的 `pnpm-workspace.yaml` 里设 `minimumReleaseAge: 0`，再或者等满一天。

**改了代码没生效。** 宿主只在进程启动时读插件，浏览器又会缓存旧文件：重启 `dsh web`，再硬刷新（`Ctrl + F5`）；桌面端彻底退出并重开应用。

**设置页不见了。** 重启 + 硬刷新；还是没有，就把安装命令原样再跑一遍：`dsh plugin --profile web add @hawkongz/dsh-task-reminder`。

## 进阶

### 自定义提示音（用你自己的音频）

「设置 → 任务提醒 → 自定义音效 → 选择文件」接受本机音频（mp3 / wav / ogg / m4a 等浏览器能解码的格式，上限 5 MB）。选完立刻按当前音量试听一次，之后每次提醒都用它。

音频**只存在你自己的浏览器里**：不上传、不进插件包，宿主半侧完全不参与。它按浏览器本地保存，重启后仍在，但「清除站点数据」或换浏览器就没了——那时重新选一次即可，行内会如实提示文件已丢失。点**清除**会删掉它并把音效切回第一种合成音效。存不下或者解不开（隐私模式、配额满、编码不支持）时，行内直接说明原因，提醒回落到合成音效，不会变哑。

### 检查更新与一键升级

设置页最底下一行显示当前版本和一个按钮。检查更新**同时问 npm 官方源与国内镜像**，取两边答出来的更高版本——镜像还没同步完，不会把「其实有新版」说成「已是最新」；其中一个源连不上，也照样有另一个的答案。只有两个源都不通，才如实报失败。

点了升级就交给 DSH 自己的插件管理服务去装（不是自己拼一条 pnpm 命令），装完提示重启 DSH 生效。两种情况会如实拒绝而不是做一半：

- **本地开发安装**（profile 里是 `link:` / `file:`）：仍然告诉你有没有新版，但不提供会覆盖你工作目录的按钮；
- **没有插件管理服务的组合**：说明原因，并给出手动升级命令。

没有上传、没有遥测：检查就是一次普通的版本查询，更新就是在你自己的 profile 里装一次包。

### 浏览器控制台助手

想自己排障，或者只想先看看通知长什么样：

```js
// 当前状态：通知权限、八个配置、通知语言、弹窗时机、各会话运行状态、计数与最近几次停止
__dshTaskReminder.state()

// 立刻发一条「任务完成」通知并放一声（不用等任务停止）
__dshTaskReminder.test()
__dshTaskReminder.test('question')   // 「提问」通知
__dshTaskReminder.test('plan')       // 「方案待确认」通知
__dshTaskReminder.test('approval')   // 带「同意 / 拒绝」按钮的审批通知（只回测试反馈，不裁决真实请求）
__dshTaskReminder.test('error')      // 「任务出错已停止」通知

// 只按当前音效与音量放一声
__dshTaskReminder.sound()

// 不点通知，直接跳到最近一条提醒的会话（用来把「点击有没有送达」和「跳转本身成不成」拆开）
__dshTaskReminder.jump()

// 对当前打开的会话再跑一次「落到你这次提问的位置」（DSH 升级后想确认这步还好使时用）
__dshTaskReminder.focusQuestion()

// 一行看清上次落点走到哪一步，以及这一步依赖的页面结构实况（哪一项变成 0 / null 就是断在哪）
__dshTaskReminder.report()
```

### 数据与隐私

- 八个配置项与自定义音频都只存在你**自己的浏览器**里，重启后仍在；
- 插件不上传任何东西，也没有遥测；
- 会联网的只有「检查更新」，而且只在你点那个按钮时才发生（见上）。

## 安装细节

### 前置条件

- 跑着 `web` profile 的 DeepSeek Harness（`dsh web`）；
- `PATH` 上有 pnpm——`dsh plugin` 会把参数原样转给 profile 目录里的 pnpm；
- Node.js 20 或更高（跑自检要用）；
- 支持 Web Audio、最好也支持 Notification API 的浏览器。

### 安装命令做了什么

一条命令同时做两件事：把包装进 profile 目录，并把 `@hawkongz/dsh-task-reminder` 追加进 profile 的插件清单（`dsh.profile.bundles`），随后加载器应用包自带的 bundle 行——不需要手动登记。本包不带构建脚本，pnpm 不会拦安装。

包名只能带 scope：裸名 `dsh-task-reminder` 被 npm 判定与现存包 `dsh-taskreminder` 过于相似，永久拒发。

### 想钉住某一个版本

```powershell
dsh plugin --profile web add @hawkongz/dsh-task-reminder@1.6.3
```

新版还没满 pnpm 的「一天冷静期」时就必须这样装（见[常见问题](#常见问题)）。pnpm 会把这条豁免写进 profile 的 `pnpm-workspace.yaml`，并立刻装上。想确认某个 profile 实际装的是哪一版：

```powershell
(Get-Content $env:USERPROFILE\.dsh\profiles\web\node_modules\@hawkongz\dsh-task-reminder\package.json | ConvertFrom-Json).version
```

### 从 GitHub 装

```powershell
# 默认分支
dsh plugin --profile web add github:hawkongz/dsh-task-reminder

# 钉某个发布标签，而不是默认分支
dsh plugin --profile web add github:hawkongz/dsh-task-reminder#<tag>
```

### 确认装上了

```powershell
dsh --profile web --dump-config | Select-String task-reminder
```

### 卸载

```powershell
dsh plugin --profile web remove @hawkongz/dsh-task-reminder
```

`remove` 会一并卸载并把这一行从插件清单里整理掉，之后重启 `dsh web` 让组合配置生效。

### 包里有什么

`index.js`（宿主半侧）、`client.js`（浏览器半侧）、`cordis.patch.yml`（插件行）、自检脚本 `test/`，以及文档。

## 开发与相关文档

- 实现细节（为什么这样做、边界情况、内部结构）：[docs/how-it-works.md](docs/how-it-works.md)
- 版本历史：[CHANGELOG.md](CHANGELOG.md)
- 参与贡献、本地开发与自检：[CONTRIBUTING.md](CONTRIBUTING.md)
- 安全问题：[SECURITY.md](SECURITY.md)
- 许可：[LICENSE](LICENSE)

GitHub 标签：[`dsh`](https://github.com/topics/dsh) [`deepseek-harness`](https://github.com/topics/deepseek-harness) [`cordis`](https://github.com/topics/cordis) [`cordis-plugin`](https://github.com/topics/cordis-plugin) [`web-ui`](https://github.com/topics/web-ui) [`notification`](https://github.com/topics/notification) [`reminder`](https://github.com/topics/reminder) [`web-audio`](https://github.com/topics/web-audio)

## 许可证

基于 [MIT](LICENSE) 协议开源。
