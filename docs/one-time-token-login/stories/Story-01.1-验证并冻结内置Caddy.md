---
kind: story
id: STORY-01.1
epic: EPIC-ONE-TIME-TOKEN-LOGIN
title: 验证并冻结内置 Caddy
gate: COMPONENT
depends_on: [STORY-01]
updated: 2026-08-18
intent_version: 1
---

# STORY-01.1：验证并冻结内置 Caddy

## 愿景

让 dsh-auth 拥有一个无需用户安装或配置网关的公网边缘。只有标准 Caddy 确实满足认证、安全、实时连接和性能边界后，安装器才正式切换。

## 范围

固定标准 Caddy `v2.11.4`，使用项目独占配置和临时进程验证最终 `/auth/verify` 协议。覆盖 TLS、HTTP/2、WebSocket、SSE、下载、续期 Cookie、动态跳转、Origin、伪造 Header 和公开 verify；同机与 Nginx 比较性能。不修改正式安装器，也不先写自定义模块。技术细节见[执行卡](../agent/STORY-01.1-验证并冻结内置Caddy执行卡.md)。

## 解决方案概览

- 使用官方标准 Caddy 二进制和受管配置，不探测系统网关。
- Caddy 负责 TLS、代理、实时连接、请求大小和连接管理。
- TS 继续负责登录、会话、CSRF、Origin、限流和身份结果。
- 配置无法满足安全边界时保持阻塞，只评估最小项目模块。

## 验收标准

- Caddy `v2.11.4` 的来源、SHA-256、许可证和配置可复现，Admin API 关闭。
- 页面未认证返回动态 303，API/实时接口返回 401，公开 `/auth/verify` 返回 404。
- TLS、HTTP/2、WebSocket、SSE、下载、续期 Cookie、Host/Origin 和伪造身份 Header 全部符合认证边界。
- 同机吞吐不低于 Nginx 的 80%，p95 恶化不超过 25%，无异常 5xx、SSE 中断或 WebSocket 断连。
- 标准配置若不能满足任一安全边界，本 Story 保持 blocked，不直接恢复完整 Go Gateway。
