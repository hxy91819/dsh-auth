---
story: STORY-02
intent_version: 3
refreshed: 2026-08-18
code_baseline: 4a0fe68b0fabfe74d37f1148fb6e78a05b3a2076
owns: [INSTALLER_V2]
verifies: [AUTH_STATE]
---

# STORY-02 建立企业版 v2 安装契约执行卡

- 状态：已完成实现与聚焦验证，主工作区 `main` 未提交 @ `4a0fe68b0fabfe74d37f1148fb6e78a05b3a2076`
- 对应：[STORY-02 建立企业版 v2 安装契约](../stories/Story-02-建立企业版v2安装契约.md)

## 目标与完成信号

把企业版 v2 的 setup、plan、Cordis/env、受管 Caddy 与服务、受管路径、doctor、reset-password、uninstall 和容器输出变成一套可冻结契约。完成时不依赖或接管用户网关，两种初始化均能生成正确状态，schema v1 安全拒绝，所有计划和非签发 JSON 保持 secret-free。

## 决策边界

- 完整公开面以[接口与参数契约](./接口与参数契约.md)为准；不得保留旧用户、角色、路径或 JSON 别名。
- 删除 `--nginx`、`--authorize-nginx-install` 及全部 Nginx 探测、安装、复用和兼容别名。
- Caddy 固定 `v2.11.4`，只来自项目发布的已校验内容；安装器不联网下载二进制，也不探测系统 Caddy。最终发布形态由 STORY-06 按人读 Story 中已确认的单包决策完成。
- HTTPS 使用 `--tls automatic|manual`；automatic 拒绝证书参数，manual 要求证书和私钥。
- 本 Story 创建 token 目录但不生成 token，不实现 `/auth/token`。
- v1 只诊断和指导重装，不自动删除、覆盖、迁移或调用卸载。
- 容器产物必须能由同一运行时 Config 与后续签发命令使用，不能依赖 systemd 私有事实。

## 技术方案

以 STORY-01.1 冻结的标准 Caddy 配置为唯一边缘输入。将 CLI parsing、setup request 构造和命令执行保持模块化，避免 `src/cli.ts` 超过代码健康阈值。

`SetupRequest` v2 删除 userId/roles，加入 adminBootstrap、adminUsername、loginTokenEnabled 和双语文案。password 源继续只存在执行请求，不进入 fingerprint/install-state；plan 从不读取密码。设置 fingerprint 包含所有非秘密 v2 选择。

installer 按 `process.platform/process.arch` 选择项目提供的 Caddy 内容，验证 manifest、官方 checksum、项目 checksum 和许可证后复制到项目自有路径。缺失、版本不符或篡改均在变更系统前失败。生成关闭 Admin API 的受管配置和独立 `dsh-auth-caddy.service`；使用 DynamicUser、最小 bind capability、systemd credentials 与受管 state/config 目录。

installer 用 STORY-01 的 schema 创建 auth-state。automatic TLS 由 Caddy 管理证书；manual 通过 systemd credentials 只读证书和私钥。计划在 apply 前确认公网端口空闲，冲突时不停止、修改或接管任何服务。journal/rollback 同时覆盖 Caddy 二进制、配置、credentials、unit、端口与原服务状态。

`reset-password` 对活动服务执行 stop → 备份状态与 secret → 写新 hash、清 session、旋转 secret → start；失败恢复两份文件和原 active 状态。未活动服务保持未活动。外部命令输出继续 withheld。

## 权威输入

- [核心决策](./核心决策.md)、[接口与参数契约](./接口与参数契约.md)、[门禁](./门禁.md)。
- STORY-01 auth-state 交接和 STORY-01.1 Caddy 配置/分发交接。
- [安全矩阵](./安全威胁与验收矩阵.md) SEC-09、18、20、21、26、FUN-01、02、03、10、12、13。
- 代码入口：`src/cli.ts`、`src/config.ts`、`src/installer/`、主包 Caddy 内容、`cordis.patch.yml`、`cordis.overlay.yml`、`deploy/`、`tests/installer-*.spec.ts`、`tests/config.spec.ts`、`tests/plugin.spec.ts`。
- Harness 基线：锁定 `0.1.0-rc.7`，领取时 npm latest 必须一致。
- 当前参数优化意图：JSON/prompt 解耦、`--dsh-executable`、默认值一致、output-dir 推导、统一 password-stdin、等号语法和全局 flag 前置。

## 领取检查

确认 STORY-01.1 done，Caddy 版本、checksum、标准配置和性能结论可复现；再次确认 npm latest 等于锁定 Harness。记录分支、HEAD、origin、工作树和 worktree；从 STORY-01.1 acceptance commit 创建专用 worktree。更新本卡和 Story 状态，运行 installer/config/plugin 现有测试保存首次失败。

领取记录（2026-08-18）：STORY-01.1 已完成；npm latest 与锁定 Harness 均为 `0.1.0-rc.7`；分支 `main`，HEAD `4a0fe68b0fabfe74d37f1148fb6e78a05b3a2076`，origin `git@github.com:hxy91819/dsh-auth.git`，工作区干净，仅主 worktree `/data/code/dsh-auth`。按操作者要求直接在主工作区开发，不另建 worktree。

## 执行步骤

### 1. 冻结 parser 与 v2 request

用表驱动参数声明实现完整 flag 集、全局位置、`--name=value`、条件必填和冲突。完成条件：帮助文本与测试从同一声明核对，未知/重复/旧参数均退出 2。

- [x] 完成。`FLAG_DECLARATIONS` 驱动 parser 与帮助文本；旧 Nginx/身份参数退出 2。

### 2. 切换 Cordis 和环境契约

固定 `/auth`，只接受 v2 文件路径和策略，删除静态用户、hash、literal secret 和 sessionStore。完成条件：patch/overlay 等价且互斥，未知/旧字段失败，路径与文案严格验证。

- [x] 完成。`cordis.patch.yml` / `cordis.overlay.yml` 映射 v2 env；未知/旧字段失败。

### 3. 实现 Caddy 平台分发与服务

建立 x64/ARM64 精确包、checksum/license/manifest 校验，生成 automatic/manual 配置、credentials 和 DynamicUser unit。完成条件：安装不下载二进制，缺包/篡改/端口冲突失败关闭，Admin API 不可用。

- [x] 完成。FakeHost 覆盖两平台、缺包、篡改和许可证；真实安装从不下载二进制。

### 4. 更新计划、运维与回滚

创建 v2 auth-state、secret、token 目录和 env；doctor 校验 Caddy 版本、checksum、配置、服务、端口与 Harness loopback；rollback/uninstall 精确恢复或删除拥有的边缘资产。完成条件：幂等、升级、活动/非活动和失败恢复有固定测试。

- [x] 完成。system/output 路径、token 目录、v1 拒绝、rollback 与 uninstall 已有测试。

### 5. 固化 JSON v2 和交接

更新所有非签发命令成功/错误 JSON、帮助和 installer 文档内部说明，运行聚焦和质量检查。公开 README 更新留给 STORY-06。

- [x] 完成。JSON `schemaVersion` 为 2；`docs/installer.md` 已改为 v2 内部说明。

## 验证与证据

```bash
corepack pnpm vitest run tests/config.spec.ts tests/plugin.spec.ts tests/installer-cli.spec.ts tests/installer-system.spec.ts tests/caddy-installer.spec.ts
corepack pnpm run check:caddy
corepack pnpm run check:code-health
corepack pnpm run typecheck
git diff --check
```

2026-08-18 验证：上述命令及全量 `vitest run`（90/90）均退出 0。原实现按独立包名解析 Caddy；用户随后否决该发布形态，因此只保留通用的内容校验、配置、服务和回滚证据。主包内置来源、双架构选择与离线安装证据已撤销，交由 STORY-06 复验。

## 停止条件

- STORY-01.1 未证明标准 Caddy 满足安全和性能边界。
- 领取基线缺少已确认的参数优化行为，或出现与 v2 接口契约冲突的后续改动。
- 需要保留任一 v1 alias、自动迁移、自动卸载或改变现有退出码含义。
- systemd 停止边界会影响非目标服务，或容器输出无法表达 v2 运行路径。

## 交接

交付 v2 Config/CLI/installer、受管 Caddy 与服务、受管路径、doctor/reset/uninstall、容器产物、行为测试、起止提交和干净状态。给 STORY-03 固定：install-state 中的 public origin、authStateFile、token enabled、service UID/GID 字段，以及容器显式参数校验入口。给 STORY-06 留下主包 Caddy 来源和发布候选复验。
