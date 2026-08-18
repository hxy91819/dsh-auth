---
story: STORY-01
intent_version: 1
refreshed: 2026-08-18
code_baseline: 5bb2c219b8422c35735e4fb73036710ae61b04e8
owns: [AUTH_STATE]
verifies: []
---

# STORY-01 建立统一管理员认证状态执行卡

- 状态：进行中
- 对应：[STORY-01 建立统一管理员认证状态](../stories/Story-01-建立统一管理员认证状态.md)

## 目标与完成信号

用一个服务拥有、原子持久化的 v2 认证状态替代启动时只读的单账号和独立 sessions 文件。完成时固定管理员身份、未设置/已设置凭据、密码与令牌两类 session、动态用户名、续期、撤销和重启恢复均有行为测试；现有 Cookie 和 session 外部语义保持不变。

## 决策边界

- 固定 ID/角色、状态 schema、密码策略、session secret 分离和首次设置撤销规则见[核心决策](./核心决策.md)，不得兼容 v1 状态。
- 本 Story 不新增 token 签发、HTTP token 路由、安装器参数或管理员页面。
- 可以拆分 `session.ts` 以满足代码健康门禁；不能通过宽泛 lint/依赖例外绕过边界。
- 只有无法从现有认证状态原子满足“保留当前、撤销其他”时才停止请求架构决策，不得改成最终一致。

## 技术方案

新增独立认证状态模块，拥有 schema 解析、权限检查、原子写入和内存快照；`SessionStore` 通过该模块执行 mutation，不再单独写 sessions JSON。状态格式以[接口契约](./接口与参数契约.md)为准。

同目录临时文件使用独占创建和 `0600`，完整写入后 fsync 文件、rename 到目标、fsync 父目录。任何步骤失败恢复内存快照并清理严格命名的临时文件。加载拒绝 symlink、非普通文件、宽权限、过大/空文件、未知 schema、重复 session 和不一致时间。

管理员用户名和 Argon2id 可以同时为 null 或同时有效，不允许半配置。状态的 `secretId` 与当前 session secret 不一致时保留管理员凭据、清空 session 并原子写回。Session 只存 token、authenticationMethod 和时间；`session`、`verify`、account 与边缘身份 Header 每次从当前管理员状态派生 `userId=admin`、`roles=[admin]` 和 username。

提供单次原子操作 `initializeAdministrator(currentSession, username, hash)`：仅未配置时成功；保留指定 session、撤销其他 session、更新管理员。具体 HTTP 输入和 hashing 由 STORY-05 调用。

## 权威输入

- [用户需求](./用户需求.md)、[核心决策](./核心决策.md)、[接口与参数契约](./接口与参数契约.md)。
- [安全矩阵](./安全威胁与验收矩阵.md) SEC-14、15、16、17、19、23、24。
- 代码入口：`src/session.ts`、`src/config.ts`、`src/application.ts`、`src/cookies.ts`、`tests/session-persistence.spec.ts`、`tests/auth-http.spec.ts`。
- Harness 基线：锁定 `0.1.0-rc.7`；领取时 npm latest 必须与锁定版一致，扩展点以官方 rc.7 checkout 为证据。
- 质量边界：仓库 `AGENTS.md` 与 `docs/code-health/README.md`。

## 领取检查

确认 STORY-01 `intent_version: 1`；再次读取 npm latest 并要求它等于仓库精确锁定 Harness；复核最新主线没有重叠的未提交改动。记录当前 branch、HEAD、origin、`git status --short` 和 `git worktree list`。从领取时的最新已提交基线创建同级专用 worktree，更新本卡 `refreshed`、`code_baseline`、Story owner/status，并运行现有 session/auth 聚焦测试保存基线结果。

## 执行步骤

### 1. 保存旧行为基线

补充或确认 Cookie、72 小时 TTL、idle、renewal、logout、容量、重启和 secret 轮换的外部测试。完成条件：新实现必须保持的结果先有可失败断言。

### 2. 建立 v2 状态解析与原子存储

实现严格 schema、所有权/权限/大小检查、temp-fsync-rename-fsync 和故障回滚。完成条件：损坏、symlink、宽权限、重复 session、写/fsync/rename 失败均失败关闭且旧完整状态可重载。

### 3. 迁移 SessionStore

把 create/authenticate/revoke/prune/renew 挂到统一 mutation，保存 authenticationMethod，并动态派生管理员身份。完成条件：密码 session 行为与基线一致，旧 sessionStore 配置/格式不再被接受。

### 4. 实现管理员状态操作

实现未配置状态、临时 username、原子首次设置、并发 compare-unset、保留当前/撤销其他。完成条件：并发测试固定一个成功；重启后身份与撤销结果不变。

### 5. 收敛配置和交接

只在运行时层加入完成本 Story 所需的 resolved 配置，安装器公开接线留给 STORY-02。运行聚焦与统一检查，更新证据和项目进展。

## 验证与证据

```bash
corepack pnpm vitest run tests/session-persistence.spec.ts tests/auth-http.spec.ts
corepack pnpm run check:code-health
corepack pnpm run typecheck
git diff --check
```

证据记录起止提交、状态 schema 样例、故障注入分母、并发结果、现有 session 行为测试、命令退出码和工作区状态。不得保存真实密码、hash、session secret 或 token。

## 停止条件

- 可领取基线仍包含重叠未提交改动或与接口契约冲突的新实现。
- 需要改变固定管理员身份、状态所有权、密码策略、session 对外语义或 v1 拒绝策略。
- 现有 WebServer/配置扩展点无法提供所需运行时文件，且解决方案要求修改 Harness。
- 原子写入无法在支持平台保证同目录 rename 或权限不变。

## 交接

交付认证状态模块、更新后的 SessionStore、聚焦测试、命令/退出码、故障注入计数、起止提交和干净 Git 状态。明确给 STORY-02 的唯一输入：v2 Config resolved 字段、受管 auth-state 初始文档、文件 owner/mode 和 reset-password 所需原子边界。
