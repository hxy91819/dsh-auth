---
kind: story
id: STORY-02
epic: EPIC-ONE-TIME-TOKEN-LOGIN
title: 建立企业版 v2 安装契约
status: blocked
gate: COMPONENT
owner: 待领取
depends_on: [STORY-01]
blocker: STORY-01 未完成
updated: 2026-08-18
intent_version: 1
---

# STORY-02：建立企业版 v2 安装契约

## 愿景

让交互式、自动化、systemd 和容器部署使用同一套清楚的企业版参数、状态和权限模型，不再延续单账号遗留字段。

## 范围

升级 setup、plan、Cordis 配置、环境变量、受管路径、doctor、reset-password、uninstall、容器输出和 JSON schema。吸收已确认的参数优化；不实现令牌签发或浏览器兑换。完整契约见[执行卡](../agent/STORY-02-建立企业版v2安装契约执行卡.md)和[接口与参数契约](../agent/接口与参数契约.md)。

## 解决方案概览

- setup 显式选择密码初始化或令牌初始化，并显式启停长期令牌能力。
- 删除可配置用户 ID、角色和旧用户名参数，改用固定管理员身份。
- 安装器创建认证状态、session secret 和令牌目录，按用途分配所有权。
- 全部公开 JSON 和安装状态升级为 v2，旧状态只给出重装诊断。

## TODO

- [ ] 落地 v2 setup、plan、帮助文本、参数解析和条件校验。
- [ ] 更新 Cordis 配置、环境变量和固定 `/auth` 路由契约。
- [ ] 更新 systemd 与容器受管路径、权限、计划、执行和回滚。
- [ ] 更新 doctor、reset-password、uninstall 和旧 schema 拒绝行为。
- [ ] 冻结 JSON schema v2、退出码和参数行为测试。

## 验收标准

- `password` 初始化只接受管理员用户名和一个安全密码来源；`login-token` 初始化拒绝它们并要求启用令牌。
- 已确认的 JSON、非交互、默认值、`--name=value`、全局 flag 和 `--dsh-executable` 行为全部保留。
- 安装计划和输出不含密码、哈希、session secret 或登录令牌。
- systemd 和容器产物能给后续签发命令提供同一认证状态布局。
- schema v1 不自动迁移或覆盖，只返回明确的卸载、重装和会话失效说明。
