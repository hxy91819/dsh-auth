---
story: STORY-01.1
intent_version: 1
refreshed: 2026-08-18
code_baseline: 88ca83ee462aab9c12afe6fd78c91e281a00c7b3
owns: [EDGE_RUNTIME]
verifies: [AUTH_STATE]
---

# STORY-01.1 验证并冻结内置 Caddy 执行卡

- 状态：已完成
- 对应：[STORY-01.1 验证并冻结内置 Caddy](../stories/Story-01.1-验证并冻结内置Caddy.md)

## 目标与完成信号

证明标准 Caddy `v2.11.4` 可以作为 dsh-auth 自带、固定版本、独立运行的唯一公网边缘。完成时最终 verify 协议、TLS、HTTP/2、实时连接、下载、安全 Header 和性能门槛都有真实临时进程证据，并冻结给 STORY-02 的配置和分发输入。

## 决策边界

- 不检测或复用用户 Caddy/Nginx，不修改正式安装器，不保留双网关运行模式。
- 优先使用未定制的官方 Caddy `v2.11.4`；本 Story 不写 Go 模块或完整 Gateway。
- TS 继续拥有密码/token 限流、登录、会话、CSRF、Origin、注销和身份结果；Caddy 不读取认证状态。
- 标准配置无法满足安全边界时设置 blocker，记录最小模块缺口并请求决策。
- 性能门槛是同机、同上游、同请求集的相对结果，不接受跨机器历史数字。

## 技术方案

新增受测试的 Caddy 配置生成/检查入口和一次性下载或预置的官方测试二进制。配置关闭 Admin API，通过 matcher 隐藏公开 `/auth/verify`，用 `forward_auth` 调用内部 verify，并根据 TS 返回的状态、`Location`、续期 `Set-Cookie` 和已验证身份 Header处理页面、API、HTTP 与 Upgrade 请求。

测试进程只绑定临时端口和一次性状态目录。manual TLS 使用临时证书；automatic TLS 使用本地 ACME 测试 CA，不能触达或污染公网账户。协议矩阵复用现有真实 E2E 的 profile、秘密、Chrome 和受保护路由，新增 SSE 持续性、HTTP/2、Header 清洗及动态 303/401 区分。

性能对比在预热后对同一认证状态和响应体运行 Nginx/Caddy，多轮交替采样并记录原始 JSON。门槛为 Caddy 吞吐 ≥ Nginx 80%、p95 ≤ Nginx 125%，且 5xx、SSE、WebSocket 均无异常。结果只用于冻结边缘选择，不宣称通用基准。

## 权威输入

- [核心决策](./核心决策.md)、[接口与参数契约](./接口与参数契约.md)、[门禁](./门禁.md)。
- [安全矩阵](./安全威胁与验收矩阵.md) SEC-08、22、23、24、26 与 FUN-11、13。
- STORY-01 的最终 `/auth/verify` 状态、Header、Location 和续期 Cookie 协议。
- 代码入口：`src/application.ts`、边缘模板、`scripts/real-integration.mjs`、新增 `check:caddy` 与性能 runner。
- Harness 基线：锁定 `0.1.0-rc.7`；领取时 npm latest 必须与锁定版一致。

## 领取检查

确认 STORY-01 done 且 verify 协议有行为测试；再次读取 npm latest，确认等于精确锁定 Harness。确认 Caddy `v2.11.4` 官方发布来源、许可证和各平台 checksum 可获取。从 STORY-01 acceptance commit 创建同级专用 worktree，记录 HEAD/status/worktrees，更新本卡并保存 Caddy 首次失败证据。

## 执行步骤

### 1. 建立可复现 Caddy 测试运行时

固定版本、来源、许可证和 SHA-256；创建临时二进制/配置/状态入口并关闭 Admin API。完成条件：版本或 checksum 不符时在启动前失败，cleanup 不留下进程、端口或状态。

### 2. 固定 forward-auth 协议

实现公开 verify 404、内部子请求、动态 303/401、续期 Cookie、身份 Header 覆盖和 Host/Origin 保留。完成条件：伪造 Header 不能到 upstream，TS 决定认证策略。

### 3. 验证网络和 TLS 能力

覆盖 manual/local automatic TLS、HTTP/2、SPA、API、下载、SSE、WebSocket、大小和超时。完成条件：真实客户端矩阵全部通过且无连接泄漏。

### 4. 运行同机对比

对 Nginx/Caddy 交替预热和采样，保存吞吐、p50/p95、错误、实时连接结果。完成条件：达到固定相对门槛；工具版本、请求集和原始结果可追溯。

### 5. 冻结能力与交接

记录标准配置无法表达的项。无安全缺口则冻结模板、检查入口和 STORY-02 输入；有缺口则保持 blocked，只给出最小 Caddy 模块评估。

## 验证与证据

```bash
corepack pnpm run check
corepack pnpm run check:caddy
corepack pnpm run test:e2e:caddy
corepack pnpm run benchmark:edge
git diff --check
```

证据记录 Caddy 版本、各测试平台 checksum、许可证、配置摘要、协议场景分母、TLS/HTTP2/SSE/WS 结果、性能原始 artifact 与 checksum、进程/端口/临时目录 cleanup。不得保存真实会话、密码或 token。

## 停止条件

- Caddy 无法保留动态 303/401、续期 Set-Cookie、Origin 或 WebSocket/SSE 安全边界。
- 需要让 Caddy 直接读取 auth state、会话 secret 或在配置中实现业务认证。
- 达不到性能门槛，或测试出现异常 5xx、SSE 中断、WebSocket 断连。
- 需要先写自定义模块、复用系统 Caddy/Nginx 或改变 STORY-01 verify 协议。

## 交接

交付固定 Caddy 来源/checksum/license、受测试配置、协议与性能证据、起止提交和干净状态。给 STORY-02 固定二进制内容、配置输入、服务启动参数、端口/TLS规则、doctor 检查和不存在自定义模块的结论；本 Story 不决定 npm 包或 Release 的数量。

- 结果：标准 Caddy `v2.11.4` 足以实现边缘安全边界，不需要 Go 模块或完整 Gateway。
- 起止版本：`88ca83ee462aab9c12afe6fd78c91e281a00c7b3` → `09b00badaa7d4f8af71bb3ccdc97c57f3ea2e384`。
- 固定输入：官方 release、linux-x64/linux-arm64 archive 与 binary checksum、许可证 checksum、关闭 Admin API 的受管模板。
- 首次失败：依次发现客户端 SNI、Host catch-all、空 Upgrade、绝对登录跳转和鉴权子请求 Upgrade 继承差异；均以最终协议行为修复并复验。
- 协议：manual 与 `tls internal` 均通过 rc.7 真实 E2E；HTTP/2、303/401、公开 verify 404、Header 覆盖、续期 Cookie、SSE、WebSocket、下载和回环监听成立。
- 性能：[原始 JSON](./evidence/edge-benchmark-2026-08-18T062356-259Z.json)，SHA-256 `149fb54ec08fa2e2e0c38c6fe6b36c2a29bed1a3948b4a9050a888243e873d37`；吞吐比 1.334，p95 比 0.811，5xx 为 0，两边 SSE/WS 均通过。
- 清理：每个检查拥有临时进程、端口、证书和状态目录并在结束时删除；证据不含密码、Cookie 或 token。
- 验证：`check`（89/89）、`check:caddy`、双 TLS `test:e2e:caddy`、`benchmark:edge`、`check:nginx`、Nginx `test:e2e`、规划结构检查、`git diff --check` 和 `npm pack --dry-run` 均退出 0；包内共 68 个文件。
- STORY-02 输入：发布内容只使用未修改官方二进制、LICENSE、manifest 和第三方声明；安装器渲染本模板，使用独立状态目录并在启动前执行 checksum/version/config 校验。最终分发形态由用户确认后冻结为一个自包含主包。
