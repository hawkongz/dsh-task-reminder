/**
 * dsh-task-reminder —— 宿主半侧。
 *
 * 浏览器半侧（./client.js）已经独立完成全部功能：
 *   - 完成信号：`ctx.remote.$on('api-session/status', …)`（宿主事件转发白名单内）；
 *   - 两个开关：`createSnapshotStore(value, { persist: { name } })`，
 *     值落在浏览器本地持久存储里，重启后仍在，不需要宿主设置文档命名空间。
 *
 * 所以宿主半侧不注入任何工具、命令、提示词，也不注册设置段 —— 与
 * `@deepseek-ai/dsh-client-ui-trajectory` 的 `apply() {}` 一致。
 * 保留这个文件是因为 bundle 的插件行（cordis.patch.yml 的 insert）按包名
 * 解析到本入口；没有它整行挂不上。
 *
 * @module dsh-task-reminder
 */

/** 宿主半侧无行为。 */
function apply() {}

export { apply };
