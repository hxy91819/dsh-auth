---
kind: story
id: STORY-06
epic: EPIC-ONE-TIME-TOKEN-LOGIN
title: 完成企业版发布验收
status: in_progress
gate: RELEASE
owner: Cursor
depends_on: [STORY-05]
blocker: 无
updated: 2026-08-18
intent_version: 2
---

# STORY-06：完成企业版发布验收

## 愿景

让维护者和云托管商能凭同一套可复现证据判断企业版 v2 是否可以发布、如何部署，以及失败时如何安全恢复。

## 范围

在验收时的 npm latest Harness 上完成跨组件安全与真实 E2E、Caddy、代码健康、打包、公开文档、秘密扫描和发布证据。确认旧版采用卸载重装，不实现自动迁移。详细步骤见[执行卡](../agent/STORY-06-完成企业版发布验收执行卡.md)。

## 解决方案概览

- 用锁定和 npm latest Harness、真实浏览器和 Caddy 验证完整控制台旅程。
- 用失败注入覆盖并发、重启、文件权限、回滚和不可重放性。
- 复验 x64/ARM64 平台包、automatic/manual TLS、systemd 和离线安装。
- 更新公共安装、云平台接入、重装、doctor 和故障排查说明。
- 检查发布包和 Git 元数据不含令牌、凭据或私有信息。

## TODO

- [x] 固定验收时 npm latest，并完成锁定/latest Harness 全量检查。
- [x] 完成统一代码健康、功能、构建、包结构和 Caddy 检查。
- [x] 完成密码与令牌两种初始化的真实 E2E 和失败注入。
- [ ] 完成 systemd、容器、doctor、uninstall 和重装验收。
- [ ] 检查打包产物、Git 元数据、日志和证据并形成发布结论。

## 验收标准

- 锁定 Harness E2E、`test:e2e:latest-dsh`、`check`、`check:caddy`、打包检查和差异检查全部通过。
- 安全矩阵中的每个阻断场景都有同一 acceptance commit 上的通过证据。
- systemd 与容器均能签发和兑换令牌；x64/ARM64、两种 TLS、服务重启、状态写入失败和回滚结果明确。
- 公开文档准确说明 v2 参数、敏感输出、云控制台集成、旧版卸载重装和会话失效。
- 发布包、日志、错误、计划、Git 元数据和文档不含真实 token、密码、私有路径或服务名。
- SEC 26/26、FUN 13/13、COMPONENT 6/6、RELEASE 1/1 在同一 acceptance commit 关闭。
