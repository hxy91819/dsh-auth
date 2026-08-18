---
story: STORY-03
intent_version: 1
refreshed: 2026-08-18
code_baseline: c7075123eb52cca412d1b2152eb65ac3bdc91849
owns: [TOKEN_ISSUANCE]
verifies: [INSTALLER_V2]
---

# STORY-03 交付一次性令牌签发执行卡

- 状态：done（2026-08-18，opencode，feature/story-03-login-token-issuance）
- 对应：[STORY-03 交付一次性令牌签发](../stories/Story-03-交付一次性令牌签发.md)

## 目标与完成信号

交付 `issue-login-token`，让 systemd 和容器以同一 JSON v2 契约生成五分钟内、一次性使用的登录链接。完成时 token 明文从不落盘或出现在失败输出；摘要存储、TTL、32 项容量、权限、并发签发和过期清理均有故障注入证据。

## 决策边界

- token 格式、摘要文件、TTL、容量、输出和调用者权限以[核心决策](./核心决策.md)与[接口契约](./接口与参数契约.md)为准。
- 本 Story 不实现消费 token 或创建 session；可提供后续消费使用的最小 store API。
- 不新增 Unix socket、守护进程、数据库或主 auth-state 中的 token 列表。
- 未知文件永不读取、覆盖或清理；不以扩大目录权限解决 CLI 与服务共享。

## 技术方案

建立 Node 端 `LoginTokenStore`，供 CLI 签发和后续应用消费。它不依赖 installer；CLI 负责把 systemd install-state 或容器显式输入解析为已验证的目录、owner 和 public origin。

签发流程：校验调用者与路径 → 清理严格匹配且过期的 token/consuming 文件 → 统计有效项 → 生成 `dsh_otl_v1_` token → SHA-256 得到文件名 → 在同目录独占写临时元数据、fsync、设置 owner/mode、rename、fsync 目录 → 构造 fragment URL → 输出。token 文件发布成功后若 stdout 失败，不尝试猜测是否已交付；保留至过期，但错误不得包含 token。

随机文件名碰撞重新生成，设置有限重试并在耗尽时返回 execution error。元数据时间使用注入时钟，解析严格拒绝未知字段、非安全整数、倒置或超最大 TTL。清理只处理受管正则和已过期项；解析失败形成安全冲突，不静默删除。

## 权威输入

- [用户需求](./用户需求.md)、[核心决策](./核心决策.md)、[接口与参数契约](./接口与参数契约.md)。
- [安全矩阵](./安全威胁与验收矩阵.md) SEC-02、10、11、12、21、FUN-07、08。
- STORY-02 交接的 v2 install-state、路径和 service identity。
- 代码入口：`src/cli.ts`、`src/installer/plan.ts` ownership parser、`src/crypto.ts`、新增 token store、`tests/installer-cli.spec.ts` 和新增 token-store 行为测试。
- Harness/Caddy 基线：锁定 Harness `0.1.0-rc.7` 与 Caddy `v2.11.4`；领取时 npm latest 必须与锁定 Harness 一致。

## 领取检查

确认 STORY-02 done、v2 JSON/Caddy/路径提交可复现，npm latest 等于锁定 Harness，且主工作区无重叠 token 改动。创建同级专用 worktree，记录基线并更新本卡。先写失败测试覆盖格式、TTL、容量、system/container 权限和 redaction。

## 执行步骤

### 1. 建立 token store 行为

实现格式、摘要元数据、严格加载、原子创建、冲突重试、容量和过期清理。完成条件：测试不依赖私有调用次数，实际目录结果符合模式和内容契约。

### 2. 实现 systemd 输入

从默认 v2 install-state 推导 enabled、auth state、token dir、public origin 和 UID/GID，要求 root。完成条件：tampered state、旧 schema、disabled、路径漂移均在生成随机 token 前失败。

### 3. 实现容器输入

要求 auth-state-file/public-origin 成对出现，校验 origin、state owner/mode 和 sibling token dir。完成条件：root 或唯一 owner 成功，其他 UID、HTTP 公网、路径/query/fragment、symlink 均失败。

### 4. 实现授权和输出

接入 parser、TTY 确认、非交互授权、TTL、人读 URL和 JSON v2。完成条件：只有成功 stdout/JSON 含 bearer secret；所有 error/diagnostic 通过扫描。

### 5. 收敛证据

运行聚焦测试和代码健康；记录 TTL/容量/UID/故障固定分母、输出样例 redaction、提交和下一 Story 的 consume API。

## 验证与证据

```bash
corepack pnpm vitest run tests/installer-cli.spec.ts tests/login-token-store.spec.ts
corepack pnpm run check:code-health
corepack pnpm run typecheck
git diff --check
```

证据必须包含 60/300/边界外 TTL、第 32/33 项、过期释放、并发签发、RNG 冲突、写/rename/stdout 故障、system/container UID、恶意 origin/路径及 stdout/stderr 扫描。

## 停止条件

- STORY-02 未提供可验证的 public origin 或 service owner。
- 支持文件系统不能提供同目录原子 rename，或容器无法保证状态目录唯一所有者。
- 需要把 token 放入 argv、环境、install-state、主 auth-state 或日志。
- 要改变 token 格式、TTL、容量、输出字段或非交互授权语义。

## 交接

交付签发命令、token store、system/container 解析、测试、起止提交和干净状态。给 STORY-04 固定 consume API、文件状态机、过期/损坏结果分类和不会包含 raw token 的诊断边界。

交付记录（2026-08-18）：

- 起止：`c707512`（领取基线）→ 本卡提交（feature/story-03-login-token-issuance）。
- 命令与退出码：`corepack pnpm run test` 0（117/117，含 login-token-store 11 项、issue-login-token CLI 13 项）；`corepack pnpm run check` 0（publint client.js CJS 警告为基线已有）；`corepack pnpm run check:caddy` 0；`corepack pnpm run typecheck` 0；`git diff --check` 0。
- 固定分母：TTL 60/300 秒闭区间、容量 32/33、RNG 冲突重试上限 8、token `dsh_otl_v1_`+43 字符、文件名 SHA-256 64 hex、元数据仅 schemaVersion/issuedAt/expiresAt、临时/抢占前缀 `.dsh_otl_v1_tmp_`/`.dsh_otl_v1_consuming_`。
- 故障注入证据：写失败/rename 失败（FaultyTokenHost）、RNG 冲突与耗尽、stdout 首写失败保留已发布文件、容器 symlink（真实文件系统）、UID 越权（systemd 非 root=5、容器非 root 非 owner=5）、公网 HTTP/带路径/query/fragment/userinfo origin=2。
- 输出扫描：所有失败路径 stdout/stderr/JSON 断言不含 `dsh_otl_v1_` 前缀。
- 数据副作用：测试仅使用 mkdtemp 临时目录与内存 FakeInstallerHost；无真实 systemd/端口/进程改动。
- 给 STORY-04 的 consume API：`LoginTokenStore.claim(token)` 返回 `claimed|invalid`（内部先清理过期，再以 rename 抢占到 `.dsh_otl_v1_consuming_<digest>`，解析失败或过期一律 invalid 且不恢复文件）；`releaseClaim(claim)` 在会话持久化成功后删除抢占文件；残留 consuming 文件视为已消费，仅由严格命名+过期清理删除；损坏受管文件形成安全冲突（conflict，不静默删除）。
