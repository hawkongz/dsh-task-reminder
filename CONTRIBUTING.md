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
4. 跑一遍自检：`node test/verify-client.mjs`
5. 提交变更：`git commit -m "feat: 添加 XX 功能"`
6. 推送到分支：`git push origin feature/your-feature`
7. 创建 Pull Request

## 开发环境

```bash
# 克隆项目
git clone https://github.com/hawkongz/dsh-task-reminder.git
cd dsh-task-reminder

# 运行自检（无需安装依赖，无运行时依赖）
node test/verify-client.mjs
```

改完 `client.js` 后的生效流程（宿主不热读客户端产物）：

```bash
# 1. 自检
node test/verify-client.mjs

# 2. 重启宿主，然后在浏览器里硬刷新（Ctrl + F5）
dsh web
```

## 代码风格

* 浏览器半侧（`client.js`）用制表符缩进，宿主半侧（`index.js`）保持空 `apply() {}`
* 可见文案全部走 `ctx.locale`（中英文案键集合必须一致）
* 样式只用主题 token（`--dsw-alias-*`），不写死颜色
* 资源（订阅、定时器、样式标签、监听）一律挂 `ctx.effect`，卸载时整体回收
* 新行为必须同步扩充 `test/verify-client.mjs` 的桩断言
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
