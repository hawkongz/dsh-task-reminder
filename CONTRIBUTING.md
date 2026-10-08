# 贡献指南

感谢关注 dsh-task-reminder！以下是参与贡献的指引。

## 如何贡献

### 报告 Bug

1. 在 [Issues](https://github.com/hawkongz/dsh-task-reminder/issues) 里搜索是否已有相同问题
2. 如果没有，使用 Bug 报告模板创建新的 Issue
3. 尽可能提供复现步骤和环境信息（浏览器版本、DSH 版本、profile 名）

### 提交代码

1. Fork 本项目
2. 创建功能分支：`git checkout -b feature/your-feature`
3. 编写代码和测试
4. 跑一遍自检：`npm test`（跨半侧契约 + 浏览器半侧 + 宿主半侧）
5. 提交变更：`git commit -m "feat: 添加 XX 功能"`
6. 推送到分支：`git push origin feature/your-feature`
7. 创建 Pull Request

## 开发环境

```bash
# 克隆项目
git clone https://github.com/hawkongz/dsh-task-reminder.git
cd dsh-task-reminder

# 运行自检（无需安装依赖，无运行时依赖）
npm test
```

把本地 checkout 装进 profile 开发（`link:` 让 profile 指向工作副本，改完即生效）：

```powershell
# 在放着 checkout 的目录执行
dsh plugin --profile web add link:.\dsh-task-reminder
```

改完 `client.js` 后的生效流程（宿主不热读客户端产物）：

```bash
# 1. 自检（三套都跑：改 index.js 会连带影响跨半侧契约）
npm test

# 2. 重启宿主，然后在浏览器里硬刷新（Ctrl + F5）
dsh web
```

## 自检

不需要浏览器、不联网，三套脚本一共 **591 条断言**（契约 19 + 浏览器半侧 501 + 宿主半侧 66），改完代码必须全绿：

```bash
npm test                      # 三套都跑：契约 + 两半
node test/verify-contract.mjs
node test/verify-client.mjs
node test/verify-host.mjs
```

### `test/verify-contract.mjs`

把两半放进同一个进程对拍：包名、三条路由（宿主侧的绝对路径 vs 桌面壳里页面必须用的相对形式）、版本号（`package.json` 与 `client.js` 的 `PLUGIN_VERSION` 必须相等），再把宿主的 `checkUpdate` / `applyUpdate` 真实答复喂进渲染侧的状态机——一侧改名不会再"两边都绿"地漂移；两半各自那份 semver 实现也用同一张版本表对拍。

### `test/verify-client.mjs`

用桩服务跑浏览器半侧，断言模块身份、接线、边沿判定、三条检测通道的去重与重复边沿抑制、未闭合回合不误报完成、两种弹窗时机、三种停止原因（完成 / 等你操作 / 出错）与 `turn/end` 分类的对账、回合号判据（同一个 turn 的重复边沿在 5 秒窗口过期、票据被陈旧回放清掉后仍只报一条；新 turn 在上一轮停止 5 秒内完成照报；同一个 turn 的 error 与 completion 不会各报一次；边沿风暴下每个 turn 恰好一条通知）、晚到错误撤回、提示音每次停止都响（与窗口状态无关）、子智能体过滤（默认关时三种停止都不报，打开后三种都恢复，fork 会话不受影响）、八个配置的默认值 / 读 / 写 / 恢复默认、通知语言（auto 跟随界面、钉住中英文、设置页文案仍跟界面）、弹窗时机两档说明的两行文案、审批快捷裁决整条链路（启动图里的 bundle URL、同一份 `client.js` 既当页面又当 worker、点击经 worker 转回页面、一次点击一次 `answer('allowed-once' | 'rejected')`、陈旧通知与重复点击 no-op、没有 `answer` 时的普通样式回落）、每种音效与音量对应的振荡器参数、自定义音效路径（IndexedDB 存取、`decodeAudioData` 解码后按音量播放、失败回落合成音、下次装载从 IndexedDB 恢复）、系统通知的权限路径与设置页的「申请通知权限」按钮、桌面端唤醒请求（只在桌面端、只在窗口不在前台时发出）、点通知后的落点（找到你自己的最后一条消息、跳过 hidden 行、滚动口取 `[data-conversation-scroll]` 或列的父节点、对齐到顶部下方 24 px、复查到坐稳为止、到顶 / 到底时不写、认不出列 / 提问 / 滚动口就到上限收工并记下结果）、挂起 `AudioContext` 的手势拉活，以及**检查更新那一行**（含预发布的版本比较、它可能处的每一格、这一行确实排在页面最后、两次宿主往返的 POST 内容）与资源回收。

### `test/verify-host.mjs`

用桩 `fetch` / 桩 `profileContext` / 桩 `pluginManager` 跑宿主半侧自己的逻辑：源查询（两个源都问、取更高的答案、一个挂掉仍能用另一个、两个都不通时如实报失败）、拒绝路径（`link:` 安装、没有 `pluginManager` 的组合）、传给 `installBundle` 的到底是什么、失败诊断、桌面端唤醒链路（补发梯子、助手先看再抢、退出码 0 就收手），以及三条 Connection 路由都以 `POST` 注册在各自的路径上。

### 在非 Windows 上自检

CI 跑在 ubuntu 上，而宿主自检要覆盖 Windows 才有的唤醒链路，所以 `index.js` 的 `apply()` 留了两个测试缝隙：`options.platform`（默认 `process.platform`）与 `options.transports`（默认真实网络）。自检注入 `platform: 'win32'` 加桩传输，于是在 Linux 上也能跑完整条链路；本地想模拟就用：

```js
// 存成 %TEMP%\dsh-linux-sim.mjs
Object.defineProperty(process, 'platform', { value: 'linux' });
await import('file:///C:/Users/20105/OneDrive/Desktop/ds/dsh-task-reminder/test/verify-host.mjs');
```

不注入的话 `activationCommands('linux')` 返回空、唤醒路由只会回 501——1.6.2 发布时就在这上面栽过一次。

## 代码风格

* 浏览器半侧（`client.js`）用制表符缩进；宿主半侧（`index.js`）只放浏览器半侧做不到的事（桌面端「点弹窗把窗口拉回前台」，以及只有宿主进程有资格的「检查更新 / 就地升级」两条路由），其余一律留在浏览器半侧
* 改 `index.js`（宿主半侧）必须重启宿主才生效：桌面端就是彻底退出并重开应用；只改 `client.js` 时，宿主侧 `dsh-client-hmr` 每 500ms 轮询客户端产物（mtime/ctime/size），页面上的插件会自动换新，不需要刷新；但发布出去的包与 `dsh plugin add` 装的副本仍按「重启 + 硬刷新」最稳
* 可见文案全部走 `ctx.locale`（中英文案键集合必须一致）
* 样式只用主题 token（`--dsw-alias-*`），不写死颜色
* 资源（订阅、定时器、样式标签、监听）一律挂 `ctx.effect`，卸载时整体回收
* 新行为必须同步扩充对应半侧的自检：浏览器半侧 → `test/verify-client.mjs`，宿主半侧 → `test/verify-host.mjs`；改动两半共用的路由 / 字段 / 版本号则同时看 `test/verify-contract.mjs`（它会把两半放在同一个进程里对拍）
* 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范

## 提交信息规范

```
feat: 添加 XX 功能
fix: 修复 XX 问题
docs: 更新文档
style: 代码格式调整
refactor: 重构 XX 模块
test: 添加测试
chore: 构建/工具配置变更
```
