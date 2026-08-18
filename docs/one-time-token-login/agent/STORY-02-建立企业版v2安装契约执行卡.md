---
story: STORY-02
intent_version: 1
refreshed: 待领取
code_baseline: 待领取
owns: [INSTALLER_V2]
verifies: [AUTH_STATE]
---

# STORY-02 建立企业版 v2 安装契约执行卡

- 状态：阻塞，依赖 STORY-01
- 对应：[STORY-02 建立企业版 v2 安装契约](../stories/Story-02-建立企业版v2安装契约.md)

## 目标与完成信号

把企业版 v2 的 setup、plan、Cordis/env、受管路径、状态、doctor、reset-password、uninstall 和容器输出变成一套可冻结契约。完成时两种管理员初始化均能生成正确状态，已确认的参数优化保留，schema v1 安全拒绝，所有计划和非签发 JSON 保持 secret-free。

## 决策边界

- 完整公开面以[接口与参数契约](./接口与参数契约.md)为准；不得保留旧用户、角色、路径或 JSON 别名。
- Nginx 风格名字和分离授权 flag 不重命名；`--json` 不改变 prompt，自动化显式使用 `--non-interactive`。
- 本 Story 创建 token 目录但不生成 token，不实现 `/auth/token`。
- v1 只诊断和指导重装，不自动删除、覆盖、迁移或调用卸载。
- 容器产物必须能由同一运行时 Config 与后续签发命令使用，不能依赖 systemd 私有事实。

## 技术方案

先取得参数优化任务的已提交结果，按行为吸收而不是复制主工作区补丁。将 CLI parsing、setup request 构造和命令执行保持模块化，避免 `src/cli.ts` 超过代码健康阈值。

`SetupRequest` v2 删除 userId/roles，加入 adminBootstrap、adminUsername、loginTokenEnabled 和双语文案。password 源继续只存在执行请求，不进入 fingerprint/install-state；plan 从不读取密码。设置 fingerprint 包含所有非秘密 v2 选择。

installer 用 STORY-01 的 schema 创建 `/var/lib/dsh-auth/auth-state.json`。password 模式在首次 mutation 前读取、校验、hash 密码并写已配置管理员；login-token 模式写 null 凭据。创建 login-tokens 目录只在 enabled 时发生。更新 ownership parser、journal、rollback、doctor 和 uninstall 的固定路径集合。

`reset-password` 对活动服务执行 stop → 备份状态与 secret → 写新 hash、清 session、旋转 secret → start；失败恢复两份文件和原 active 状态。未活动服务保持未活动。外部命令输出继续 withheld。

## 权威输入

- [核心决策](./核心决策.md)、[接口与参数契约](./接口与参数契约.md)、[门禁](./门禁.md)。
- STORY-01 交接和 auth-state schema。
- [安全矩阵](./安全威胁与验收矩阵.md) SEC-09、18、20、21、FUN-01、02、03、10。
- 代码入口：`src/cli.ts`、`src/config.ts`、`src/installer/`、`cordis.patch.yml`、`cordis.overlay.yml`、`deploy/`、`tests/installer-*.spec.ts`、`tests/config.spec.ts`、`tests/plugin.spec.ts`。
- 当前参数优化意图：JSON/prompt 解耦、`--dsh-executable`、默认值一致、output-dir 推导、统一 password-stdin、等号语法和全局 flag 前置。

## 领取检查

确认 STORY-01 done 且交接 commit 可复现；核对参数优化提交已包含预期测试。记录分支、HEAD、origin、工作树和 worktree；从 STORY-01 acceptance commit 创建专用 worktree。更新本卡和 Story 状态，运行 installer/config/plugin 现有测试保存首次失败。

## 执行步骤

### 1. 冻结 parser 与 v2 request

用表驱动参数声明实现完整 flag 集、全局位置、`--name=value`、条件必填和冲突。完成条件：帮助文本与测试从同一声明核对，未知/重复/旧参数均退出 2。

### 2. 切换 Cordis 和环境契约

固定 `/auth`，只接受 v2 文件路径和策略，删除静态用户、hash、literal secret 和 sessionStore。完成条件：patch/overlay 等价且互斥，未知/旧字段失败，路径与文案严格验证。

### 3. 更新计划、执行和所有权

创建 v2 auth-state、secret、token 目录、env、systemd 和 Nginx 产物；更新 journal、fingerprint、rollback 和 output mode。完成条件：password/login-token 两种计划 secret-free、幂等，未拥有路径不覆盖。

### 4. 更新运维命令

doctor 检查所有 v2 路径和内容；reset 使用服务停止边界；uninstall 只删除记录路径。完成条件：活动/非活动/失败回滚行为有固定测试，v1 均只诊断。

### 5. 固化 JSON v2 和交接

更新所有非签发命令成功/错误 JSON、帮助和 installer 文档内部说明，运行聚焦和质量检查。公开 README 更新留给 STORY-06。

## 验证与证据

```bash
corepack pnpm vitest run tests/config.spec.ts tests/plugin.spec.ts tests/installer-cli.spec.ts tests/installer-system.spec.ts tests/nginx-installer.spec.ts
corepack pnpm run check:code-health
corepack pnpm run typecheck
git diff --check
```

证据包括 v2 flag 固定分母、两种 setup 计划、system/output 路径与模式、v1 拒绝矩阵、reset 回滚矩阵、JSON 样例的 redaction 检查、命令退出码和提交。

## 停止条件

- STORY-01 schema 或文件所有权未固定。
- 领取基线缺少已确认的参数优化行为，或出现与 v2 接口契约冲突的后续改动。
- 需要保留任一 v1 alias、自动迁移、自动卸载或改变现有退出码含义。
- systemd 停止边界会影响非目标服务，或容器输出无法表达 v2 运行路径。

## 交接

交付 v2 Config/CLI/installer、受管路径、doctor/reset/uninstall、容器产物、行为测试、起止提交和干净状态。给 STORY-03 固定：install-state 中的 public origin、authStateFile、token enabled、service UID/GID 字段，以及容器显式参数校验入口。
