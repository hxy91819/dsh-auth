---
kind: epic
id: EPIC-ONE-TIME-TOKEN-LOGIN
title: 一次性令牌登录与企业版 v2
status: in_progress
owner: dsh-auth 产品与工程团队
updated: 2026-08-18
coverage: [AUTH_STATE, EDGE_RUNTIME, INSTALLER_V2, TOKEN_ISSUANCE, TOKEN_REDEMPTION, ADMIN_ONBOARDING, RELEASE_ACCEPTANCE]
---

# Epic：一次性令牌登录与企业版 v2

## 愿景

云托管商确认用户拥有实例后，可以在实例内签发短期登录链接。用户一次点击即可安全换取管理员会话，不需要由云平台保存实例密码。首次令牌登录还能建立管理员用户名和密码，后续既可继续从控制台免密登录，也可使用管理员密码登录。

动态状态统一见[《项目进展》](../项目进展.md)。

## 成功标准

| 门禁 | Epic 成功条件 |
| --- | --- |
| READY：可以开工 | 最新 Harness 已固定并验证；已提交代码基线、v2 接口、安全边界和执行卡一致 |
| COMPONENT：各部分完成 | 认证状态、Caddy、安装器、令牌签发、令牌兑换和管理员初始化六个结果各自通过行为与质量检查 |
| RELEASE：可以发布 | 一个可独立安装的主包同时包含两种架构 Caddy，并在最新 Harness 上通过真实 E2E、离线安装、秘密扫描、重装和回退验收 |

## Story 地图

| Story | 交付结果 | 门禁 | 依赖 |
| --- | --- | --- | --- |
| [STORY-01 建立统一管理员认证状态](../stories/Story-01-建立统一管理员认证状态.md) | 固定管理员身份、凭据和会话使用同一持久状态 | READY | 无 |
| [STORY-01.1 验证并冻结内置 Caddy](../stories/Story-01.1-验证并冻结内置Caddy.md) | 标准 Caddy 满足认证边界、实时连接和性能门槛 | COMPONENT | STORY-01 |
| [STORY-02 建立企业版 v2 安装契约](../stories/Story-02-建立企业版v2安装契约.md) | setup、受管 Caddy、路径和运维命令使用 v2 契约 | COMPONENT | STORY-01.1 |
| [STORY-03 交付一次性令牌签发](../stories/Story-03-交付一次性令牌签发.md) | systemd 与容器可安全签发短期登录链接 | COMPONENT | STORY-02 |
| [STORY-04 交付一次性令牌兑换](../stories/Story-04-交付一次性令牌兑换.md) | 浏览器安全、原子地换取正常管理员会话 | COMPONENT | STORY-03 |
| [STORY-05 交付管理员首次初始化](../stories/Story-05-交付管理员首次初始化.md) | 用户可设置管理员凭据或选择 Later | COMPONENT | STORY-04 |
| [STORY-06 完成企业版发布验收](../stories/Story-06-完成企业版发布验收.md) | 一个自包含主包和一个 Release 满足安装、安全与发布条件 | RELEASE | STORY-05 |

## 项目边界

- 管理员内部 ID 和角色固定为 `admin`；本期不实现普通用户。
- 密码初始化和令牌初始化是显式二选一；令牌能力启用后长期保留。
- 令牌会话与密码会话共用现有 72 小时滚动策略和安全 Cookie。
- Caddy 由项目固定版本、独占配置和独立服务管理，不探测或复用主机已有 Caddy/Nginx。
- `dsh-auth` 主包是唯一安装和发布单元，同时携带 Linux x64/ARM64 Caddy；不发布独立平台包，也不在 setup 时下载。
- 不实现浏览器内修改既有密码、云厂商用户映射、审计后台或旧版自动迁移。
- 自定义失败文案只支持纯文本，不支持 HTML、品牌组件或外部链接。
- 根 README 仍只面向公共安装和运维，不承载本项目动态状态。

## 权威文档

| 主题 | 文档 |
| --- | --- |
| 动态状态和阻塞 | [项目进展](../项目进展.md) |
| 用户目标和非目标 | [用户需求](../agent/用户需求.md) |
| 不可变架构选择 | [核心决策](../agent/核心决策.md) |
| CLI、配置、状态和 HTTP 契约 | [接口与参数契约](../agent/接口与参数契约.md) |
| 威胁、场景和验收证据 | [安全威胁与验收矩阵](../agent/安全威胁与验收矩阵.md) |
| 门禁授权 | [门禁](../agent/门禁.md) |
