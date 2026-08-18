---
kind: story
id: STORY-02
epic: EPIC-ONE-TIME-TOKEN-LOGIN
title: 建立企业版 v2 安装契约
status: done
gate: COMPONENT
owner: Cursor
depends_on: [STORY-01.1]
blocker: 无
updated: 2026-08-18
intent_version: 2
---

# STORY-02：建立企业版 v2 安装契约

## 愿景

让交互式、自动化、systemd 和容器部署使用同一套清楚的企业版参数、状态、Caddy 和权限模型，不再要求用户准备或维护系统网关。

## 范围

升级 setup、plan、Cordis 配置、环境变量、Caddy 平台包、systemd、受管路径、doctor、reset-password、uninstall、容器输出和 JSON schema。删除全部 Nginx 探测、安装和复用逻辑；不实现令牌签发或浏览器兑换。完整契约见[执行卡](../agent/STORY-02-建立企业版v2安装契约执行卡.md)和[接口与参数契约](../agent/接口与参数契约.md)。

## 解决方案概览

- setup 显式选择密码初始化或令牌初始化，并显式启停长期令牌能力。
- 删除可配置用户 ID、角色和旧用户名参数，改用固定管理员身份。
- 安装器从精确平台包校验并复制 Caddy，不在安装时下载二进制。
- 独立 Caddy 服务使用 automatic 或 manual TLS，并与 Harness 状态分权运行。
- 全部公开 JSON 和安装状态升级为 v2，旧状态只给出重装诊断。

## TODO

- [x] 落地 v2 setup、plan、帮助文本、参数解析和条件校验。
- [x] 更新 Cordis 配置、环境变量和固定 `/auth` 路由契约。
- [x] 实现平台包校验、Caddy 配置、TLS、systemd 和端口冲突契约。
- [x] 更新受管路径、doctor、回滚、uninstall 和旧 schema 拒绝行为。
- [x] 冻结 JSON schema v2、退出码和参数行为测试。

## 验收标准

- `password` 初始化只接受管理员用户名和一个安全密码来源；`login-token` 初始化拒绝它们并要求启用令牌。
- 已确认的 JSON、非交互、默认值、`--name=value`、全局 flag 和 `--dsh-executable` 行为全部保留。
- 安装计划和输出不含密码、哈希、session secret 或登录令牌。
- x64/ARM64 平台包缺失或篡改时失败；安装过程不访问二进制下载地址。
- Caddy 使用独立 DynamicUser 服务、关闭 Admin API；端口冲突不接管用户服务。
- automatic TLS 拒绝证书参数；manual TLS 要求证书和私钥，两种模式都可回滚。
- schema v1 不自动迁移或覆盖，只返回明确的卸载、重装和会话失效说明。

## 交付证据

- [x] 表驱动 v2 CLI、password/login-token 两种 setup、secret-free JSON v2 和旧 Nginx/身份 flag 拒绝已有测试。
- [x] Cordis 只接受 v2 路径与策略；x64/ARM64 包校验、automatic/manual TLS、端口冲突和 DynamicUser unit 已覆盖。
- [x] doctor、rollback、uninstall、v1 拒绝和 installer 内部说明已更新；聚焦测试、`check:caddy`、code-health、typecheck 退出 0。
