---
story: STORY-05
intent_version: 1
refreshed: 待领取
code_baseline: 待领取
owns: [ADMIN_ONBOARDING]
verifies: [AUTH_STATE, TOKEN_REDEMPTION]
---

# STORY-05 交付管理员首次初始化执行卡

- 状态：阻塞，依赖 STORY-04
- 对应：[STORY-05 交付管理员首次初始化](../stories/Story-05-交付管理员首次初始化.md)

## 目标与完成信号

令牌初始化用户可以在独立页面设置管理员用户名和安全密码，或选择 Later。完成时用户名/密码规则、并发 compare-unset、当前会话保留、其他启动会话撤销、后续密码登录和下次 token 再提示均由浏览器与 HTTP 行为测试证明。

## 决策边界

- 用户名、密码、Later、并发和会话规则以[用户需求](./用户需求.md)与[核心决策](./核心决策.md)为准。
- 本期只允许从未配置变为已配置；浏览器不能改已有用户名或密码。
- 只有已认证 session 可访问页面；初始化提交必须来自 authenticationMethod=`login-token`。已配置后任何 session 都不能覆盖。
- Later 不写 Cookie、session flag、时间或后台任务，只跳到 safe returnTo。
- 不添加 Harness 内持续 banner；账户页可以显示管理员已配置状态或未配置入口，但不得在当前 session 自动反复提醒。

## 技术方案

新增 `/auth/admin/setup` GET/POST 到现有 standalone auth UI。GET 先 authenticate；匿名跳登录，已配置显示完成状态或 303 account，未配置且非 token session 返回 403。页面复用语言/theme、安全 headers 和匿名 CSRF 机制，输入使用 `autocomplete=username/new-password`。

POST 校验同源、CSRF、表单大小和 safe returnTo。用户名 trim 只用于拒绝首尾空白，实际值先 NFC 后检查 1–64 code point、控制字符和大小；密码/confirm exact 相等，15–128 code point、UTF-8 <=1024，不 trim/normalize。验证完成才执行 Argon2id，避免无效输入消耗成本。

调用 STORY-01 `initializeAdministrator(currentSession, username, hash)`，在一个 auth-state mutation 中 compare unset、写 configuredAt、保留当前 session、撤销其他 session。若并发 loser 发现已配置，显示友好完成页，不验证或覆盖现有密码。成功清 CSRF Cookie并 303 returnTo。

密码登录每次从 auth-state 读取 username/hash：未配置时登录页不渲染密码 form，显示内置“从云控制台登录”说明；已配置后使用 constant-time username 和 Argon2id。password setup 模式从安装起已配置，不进入 onboarding。

## 权威输入

- [用户需求](./用户需求.md)、[核心决策](./核心决策.md)、[接口与参数契约](./接口与参数契约.md)。
- [安全矩阵](./安全威胁与验收矩阵.md) SEC-14、15、16、FUN-04、05、06。
- STORY-01 initialize API、STORY-04 token session 与 redirect 交接。
- 代码入口：`src/application.ts`、`src/html.ts`、`src/password.ts`、`src/preferences.ts`、`tests/auth-http.spec.ts` 及新增 onboarding/browser E2E。
- Harness/Caddy 基线：锁定 Harness `0.1.0-rc.7` 与 Caddy `v2.11.4`；领取时 npm latest 必须与锁定 Harness 一致。

## 领取检查

确认 STORY-04 done，npm latest 等于锁定 Harness，token 登录可在 Caddy 下稳定产生带 method 的 session 并跳到固定 setup route。创建专用 worktree，记录基线、工作树和 worktrees，更新本卡。先用行为测试保存未配置、Later、设置和并发预期失败。

## 执行步骤

### 1. 建立页面状态机

实现匿名、非 token session、未配置 token session 和已配置四种 GET 结果。完成条件：无 DOM 探测，所有结果 no-store、同源、双语且可访问。

### 2. 实现输入策略

建立共享 username/password validator，setup CLI 和网页登录使用同一规则。完成条件：Unicode、NFC、首尾空白、控制字符、code point/byte 边界和确认不一致有外部错误结果。

### 3. 接入原子首次设置

hash 后调用 compare-unset mutation，保留当前并撤销其他 session。完成条件：两个并发提交固定一个写入；loser 友好且不能覆盖；重启结果相同。

### 4. 实现 Later 与后续登录

Later 直接跳 safe returnTo；新的 token 登录再次提示。未配置隐藏密码 form，已配置密码登录成功且错误仍通用。完成条件：password setup 和 token setup 两条完整 HTTP 旅程通过。

### 5. 完成浏览器证据和交接

增加真实交互可用性、语言、主题、键盘/label/autocomplete 测试，运行聚焦和质量检查，更新进展。

## 验证与证据

```bash
corepack pnpm vitest run tests/password.spec.ts tests/auth-http.spec.ts tests/admin-onboarding.spec.ts
corepack pnpm run check:code-health
corepack pnpm run typecheck
git diff --check
```

证据包含用户名/密码边界分母、Later 两次 token 旅程、并发首次设置、三 session 撤销、重启、password/token setup、后续密码成功/失败及无敏感输出扫描。

## 停止条件

- STORY-01 无法在一个持久 mutation 中设置凭据并撤销其他 session。
- 需要允许非 token session 初始化、覆盖已配置管理员或在 Harness DOM 上注入提醒。
- 产品要求加入密码复杂度、泄漏密码在线查询、外部 IdP 或修改既有密码。
- Later 需要持久时间、后台调度或当前 session 内再次自动提醒。

## 交接

交付管理员设置页面、验证器、Later、并发与会话撤销、密码登录接线、测试、起止提交和干净状态。给 STORY-06 固定两条 setup 的真实用户旅程、所有文案、浏览器入口和需要全量复核的安全场景。
