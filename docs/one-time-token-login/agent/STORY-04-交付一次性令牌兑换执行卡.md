---
story: STORY-04
intent_version: 1
status: done
owner: opencode
blocker: 无
status_updated: 2026-08-18
refreshed: 2026-08-18
code_baseline: f5d8bf8aa5a364cf1c6a2971d1e40314b42bfaf9
owns: [TOKEN_REDEMPTION]
verifies: [AUTH_STATE, TOKEN_ISSUANCE]
---

# STORY-04 交付一次性令牌兑换执行卡

- 对应：[STORY-04 交付一次性令牌兑换](../stories/Story-04-交付一次性令牌兑换.md)

## 目标与完成信号

从 `/auth/token#token=…` 安全建立正常管理员会话。完成时 token 不进入查询、Referer、访问日志或后续 history；GET/HEAD 与预取不消费；POST 受 CSRF、Origin、大小和独立限流保护；并发和失败最多成功一次，所有 token 失败使用同一友好结果。

## 决策边界

- fragment、原子消费顺序、统一 401、路由、CSP 和成功跳转以[接口契约](./接口与参数契约.md)为准。
- 本 Story 只决定兑换后跳到首次设置页，不实现该页表单。
- 不使用 query token、inline token script、DOM 探测、边缘响应改写或 Harness 修改。
- token disabled 时完整 token 路由为 404，不能只让 POST 失败。
- consume 后的任何错误不恢复 token；可用性补偿只能要求重新签发。

## 技术方案

增加独立浏览器 bootstrap 源和服务端页面，保持浏览器层不依赖 Node/server 模块。GET 页面设置 no-store、no-referrer、frame deny 和只允许同源外部脚本的 CSP，签发新的匿名 CSRF cookie/token。外部脚本解析 fragment：只接受唯一 token 键，无额外键；立即 `history.replaceState` 清除 fragment，再创建隐藏表单 POST `csrf` 与 token。无 JS 显示可理解的重新打开说明。

POST 先校验 method、content type、20 KiB、trusted proxy client IP、独立 limiter、精确 Origin/Referer 和 CSRF，再清理严格匹配且已过期的受管文件并调用 STORY-03 consume。consume 对摘要目标执行 rename 到严格 `.consuming-*`，随后读取元数据、判断期限并删除；任何 raw token 不进错误对象。只有有效消费完成后调用 STORY-01 SessionStore create(`login-token`)。

已配置管理员成功 303 `/`；未配置成功 303 `/auth/admin/setup?returnTo=%2F`。invalid/malformed/missing/expired/used/corrupt 均用同一 401 token failure page。zh/en 自定义文案在配置阶段验证，HTML 层统一 escape。Caddy 代理 GET/POST；POST 应用限流独立于密码 limiter，公开 verify 仍为 404。

## 权威输入

- [核心决策](./核心决策.md)、[接口与参数契约](./接口与参数契约.md)。
- [安全矩阵](./安全威胁与验收矩阵.md) SEC-01、03、04、05、06、07、08、13、22、23、24。
- STORY-01 的 SessionStore create/authenticate，STORY-03 的 consume API 和状态机。
- 代码入口：`src/application.ts`、`src/html.ts`、`src/preferences.ts`、`src/limiter.ts`、浏览器 bootstrap 模块、Caddy 模板与 `check:caddy`、HTTP/browser tests。
- Harness/Caddy 基线：锁定 Harness `0.1.0-rc.7` 与 Caddy `v2.11.4`；领取时 npm latest 必须与锁定 Harness 一致。

## 领取检查

确认 STORY-03 done，使用实际文件系统复核 consume 原子语义；确认 npm latest 等于锁定 Harness，DSH WebServer 和浏览器扩展仍与 rc.7 基线一致。创建专用 worktree，记录 HEAD/status/worktrees，更新本卡并保存 token route 的首个失败测试。

## 执行清单

- [x] 实现安全的 fragment 桥接页面和无脚本降级提示。
- [x] 实现 CSRF、同源、请求上限和独立 IP 限流。
- [x] 实现原子消费、过期判定、失败清理和正常会话签发。
- [x] 实现内置及可选中英文纯文本失败文案。
- [x] 覆盖预取、并发兑换、重放、日志泄漏和开放跳转测试。

## 执行步骤

### 1. 固定浏览器桥接协议

实现 GET/HEAD 页面、外部脚本、CSRF、fragment parser、replaceState 和无脚本提示。完成条件：DOM/URL 测试证明 token 在表单创建前已从 location 清除，GET/HEAD 不触碰 token 文件。

### 2. 实现安全 POST 入口

复用现有 form parser、origin、CSRF、safe response headers，增加独立 limiter。完成条件：method/content type/size/origin/CSRF/rate 场景返回准确 405/415/413/403/429，且不消费 token。

### 3. 接入原子消费和会话

先 consume 再 create login-token session，按管理员状态选择 redirect。完成条件：并发成功数为 1，session persist 失败后重放仍 401，成功 Cookie 与密码基线一致。

### 4. 实现统一失败与双语文案

把 token 状态映射到单一 401 AuthMessage，不把内部原因输出。完成条件：所有失败 body/status/headers 同形，自定义/回退文案 escaped 且 no-store。

### 5. 更新 Caddy 与真实行为测试

接入公开 token 页面但不暴露 verify；验证 access log 不含 token、protected HTTP/SSE/WS/download 未回归。记录证据并交接。

## 验证与证据

```bash
corepack pnpm vitest run tests/auth-http.spec.ts tests/browser-bootstrap.spec.ts tests/login-token-http.spec.ts
corepack pnpm run check:caddy
corepack pnpm run check:code-health
corepack pnpm run typecheck
git diff --check
```

证据包含 GET/HEAD/预取不消费、history 和 Referer、兑换触发过期清理、并发双 POST、消费后会话失败、所有失败同形、限流隔离、文案注入、Caddy access log 和受保护路由。

## 停止条件

- 浏览器必须依赖 inline script、unsafe CSP 或 query token 才能完成一击登录。
- Caddy 无法避免 token 出现在 access log，或 public verify 暴露。
- consume API 会在会话失败时恢复 token，或无法区分安全冲突与普通无效。
- 要改变成功会话、Cookie、returnTo、统一失败或 disabled 404 语义。

## 交接

交付 fragment 桥接、HTTP 兑换、Caddy 接线、限流、失败页、测试、起止提交和干净状态。给 STORY-05 固定 token 成功后的 session authenticationMethod、管理员 configured 判断、`/auth/admin/setup?returnTo=/` 跳转和 CSRF 页面能力。

交付记录（2026-08-18）：

- 起止：`f5d8bf8`（领取基线）→ 本卡提交（feature/story-04-token-redemption）。
- 命令与退出码：`corepack pnpm run test` 0（132/132，含 login-token-http 12 项、token 桥接 3 项）；`corepack pnpm run check` 0（仅基线已有 6 条函数长度 warning 与 publint 警告）；`corepack pnpm run check:caddy` 0（新增 tokenRoutes 公开代理断言）；`git diff --check` 0。
- 路由契约：GET/HEAD `/auth/token` 桥接页（no-store、CSP `script-src 'self'`、`Referrer-Policy: no-referrer`、匿名 CSRF cookie）；GET/HEAD `/auth/token-bootstrap.js` 同源脚本；POST 兑换 405/415/413/403/429/401/303 语义齐全；disabled 时两路由全方法 404。
- 统一失败：missing/malformed/unknown/expired/used/corrupt 会话失败全部同一 401 no-store HTML；自定义 zh/en 文案经 html 转义；限流 429 带 retry-after 且与密码 limiter 互不污染。
- 边缘改动：两份 Caddy 模板 `Referrer-Policy` 由固定值改为 `?` 缺省填充，auth 上游（含 token 页 no-referrer）不再被覆盖；`scripts/check-caddy.mjs` 增加 token 桥接/脚本/POST 直通断言。fragment 不离开浏览器，边缘访问日志天然无 token；查询串 token 被忽略且不回显。
- 数据副作用：测试仅 mkdtemp 目录与内存配置；无真实 systemd、端口或浏览器改动。
- 给 STORY-05 的输入：兑换成功调用 `SessionStore.create(now,'login-token')`；管理员 configured 判定用 `SessionStore.passwordCredentials()`；未配置重定向 `/auth/admin/setup?returnTo=%2F`；桥接/失败页已提供 CSRF 页面能力（`issueCsrf`+cookie）；会话 Cookie 与密码登录完全一致。
