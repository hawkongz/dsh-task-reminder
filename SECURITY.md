# 安全政策

## 报告漏洞

如果你发现了安全漏洞，请**不要**直接创建公开 Issue。

改为通过 GitHub 的私人漏洞报告功能提交：
[Report a vulnerability](https://github.com/hawkongz/dsh-task-reminder/security/advisories/new)

请在报告里包含：

* 漏洞描述与影响范围
* 复现步骤
* 受影响版本
* 你建议的修复方式（如有）

我们会在收到报告后尽快确认并给出处理时间线。

## 支持范围

只有最新的 minor 版本会收到安全修复。

## 范围说明

本插件的全部代码运行在浏览器半侧；它不读取、传输或存储任何凭据，
配置值只写入浏览器本地存储（`dsh.task-reminder.*` 键）。
系统通知使用标准 Web Notification API，需要用户显式授权。
