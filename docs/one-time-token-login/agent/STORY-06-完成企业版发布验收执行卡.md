---
story: STORY-06
intent_version: 2
refreshed: 2026-08-18
code_baseline: 4b26ad2621c0e8696cb3257a6fa73acb968731f9
owns: [RELEASE_ACCEPTANCE]
verifies: [AUTH_STATE, EDGE_RUNTIME, INSTALLER_V2, TOKEN_ISSUANCE, TOKEN_REDEMPTION, ADMIN_ONBOARDING]
---

# STORY-06 完成企业版发布验收执行卡

- 状态：进行中（2026-08-18，Cursor，feature/story-06-release-acceptance）
- 对应：[STORY-06 完成企业版发布验收](../stories/Story-06-完成企业版发布验收.md)

## 目标与完成信号

在验收时的 npm latest Harness 和一个 acceptance commit 上关闭全部矩阵，完成 systemd、容器、Caddy 平台分发/TLS、代码检查、打包、公开运维文档和秘密扫描。完成信号是 RELEASE 1/1，任何维护者可复现发布结论和 v1 卸载重装路径。

## 决策边界

- 本 Story 修复验收发现的缺陷和缺失测试，但不新增产品能力或改变冻结接口；需要改变时停止并插入 Story 或 REPLAN。
- 不把 mock-only 测试当作真实 Caddy、浏览器、systemd 或容器证据。
- 领取时再次解析 npm latest；若与锁定版不同，先撤销发布 readiness 并刷新 Harness 基线。
- v1 升级只记录和验证显式卸载重装，不实现迁移脚本或自动删除。
- 公共 README 只写产品、安装、云接入和运维；贡献执行细节留在 AGENTS、installer 文档和本专题。
- 发布前按仓库规则扫描文件与 Git metadata，并使用批准的公开身份；不在未授权情况下 push 或发布。

## 技术方案

先固定 STORY-05 完成提交为候选，在新的验收 worktree 中不接受并行功能改动。把[安全矩阵](./安全威胁与验收矩阵.md)转成固定分母清单，逐项关联自动测试、真实 E2E 或人工只读检查；所有结果必须来自同一候选。

扩展真实 E2E 使用一次性 profile、秘密、进程和端口，在锁定与 latest Harness 上覆盖 password/login-token 两种 setup、systemd 签发、fragment 浏览器兑换、Later、首次设置、后续密码、续期、logout、重启和重放。容器/离线证据使用 output 产物、显式 auth-state/public-origin 和同形 JSON；不影响已有服务。

验证主包内置 x64/ARM64 Caddy、automatic/local ACME、manual TLS、Caddy access log、应用输出、计划、JSON errors、状态目录、打包产物和 Git metadata。只使用生成的测试 token/密码；证据中保存哈希或 redacted 结构，不保存 bearer secret。公开文档说明签发成功输出、自包含 Caddy、TLS、权限、doctor、重置、卸载重装和常见错误。

## 权威输入

- [Epic](../epics/EPIC-ONE-TIME-TOKEN-LOGIN.md)、[门禁](./门禁.md)、[安全矩阵](./安全威胁与验收矩阵.md)。
- STORY-01 至 05 的交接提交、命令、固定分母和未关闭风险。
- 仓库 `AGENTS.md`、`SECURITY.md`、`README.md`、`docs/installer.md`、`docs/releasing.md`、`docs/code-health/README.md`。
- 验证入口：`test:e2e`、`test:e2e:latest-dsh`、`check:caddy`、Caddy E2E、release validation tests。

## 领取检查

确认 STORY-01、01.1 至 05 均 done、COMPONENT 6/6、交接提交形成线性候选。解析 npm latest；不同于精确锁定时停止并先刷新基线。检查主仓/远端/worktrees/status，无并行认证或发布修改；创建专用验收 worktree。确认 Caddy、OpenSSL、`ss` 和 Chrome/Chromium 前置条件，再开始长测试。

领取记录（2026-08-18）：

- STORY-01 至 05 done，COMPONENT 6/6。线性候选：`43ed0ca`（STORY-05）合入 `main` 后加 `4b26ad2`（VISION 文档）。验收基线 `4b26ad2621c0e8696cb3257a6fa73acb968731f9`。
- npm latest `@deepseek-ai/dsh` = `0.1.0-rc.7`，与锁定 Harness 一致；Caddy 仍为 `v2.11.4`。用户已确认主包自包含双架构 Caddy，不再发布独立 `dsh-auth-caddy-linux-*` 包。下一正式修复版为 `dsh-auth@0.1.15`。
- 工作树 `/data/code/dsh-auth-story-06`，分支 `feature/story-06-release-acceptance`。主仓 `main` 与 `origin/main` 同步于基线；STORY-05 worktree 只读保留。
- 前置：Node `v24.15.0`、pnpm `10.14.0`、OpenSSL `3.0.12`、`ss`、systemd 255、Chrome `/usr/bin/google-chrome`。Caddy 二进制不在 PATH，E2E 使用校验后的测试预备器。

## 执行步骤

### 1. 冻结候选和矩阵

记录 candidate commit、依赖锁、Node/pnpm、锁定/latest DSH、Caddy、浏览器版本。把 SEC-01..26、FUN-01..13 标为未验证并分配唯一证据路径。完成条件：没有空主责或仅靠历史版本通过的项。

### 2. 运行全量静态与功能门禁

执行统一 check、Caddy、锁定/latest Harness、diff 和 package 检查；先修复根因，再从统一入口完整复验。完成条件：所有命令在候选提交退出 0，代码健康不新增例外。

### 3. 运行真实 Caddy、systemd 与浏览器 E2E

覆盖签发、URL/history/log、兑换、Later、首次设置、密码登录、Cookie/续期/logout、并发、重启、失败和卸载重装。完成条件：所有进程、端口、profile 和临时秘密由 E2E 所有并清理。

### 4. 验证平台分发、容器与运维恢复

验证 x64/ARM64 内置 Caddy 缺文件/篡改、automatic/manual TLS、端口冲突、output 模式签发/兑换，以及 doctor、reset-password、uninstall、v1 拒绝、写入/服务失败回滚。完成条件：安装不下载二进制、不依赖第二包，systemd 与容器 JSON 和安全语义一致。

### 5. 更新公开文档

更新 README、SECURITY、installer、部署示例、环境模板、帮助快照和变更日志。完成条件：参数名、条件、敏感输出、重装、默认值和示例与测试完全一致。

### 6. 审计包与发布证据

运行 pack dry-run 和 release tests，扫描文件、包、日志和 Git metadata，记录 checksums/退出码/cleanup。刷新专题仪表盘和门禁；只有矩阵全部关闭才设 done。

## 验证与证据

```bash
corepack pnpm run check
corepack pnpm run check:caddy
corepack pnpm run test:e2e
corepack pnpm run test:e2e:latest-dsh
npm pack --dry-run
git diff --check
```

另保存自包含 Caddy/TLS、容器 smoke、v1 重装、doctor/reset/uninstall、秘密扫描和 Git metadata 检查。交接报告必须给出 SEC 26/26、FUN 13/13、COMPONENT 6/6、RELEASE 1/1；任何跳过项保持未通过。

## 停止条件

- 候选提交在验收期间变化，或出现并行认证/Caddy/installer 修改。
- npm latest 与锁定 Harness 不同且基线尚未刷新。
- 缺少真实 E2E 前置条件且无法在隔离环境补齐。
- 任一 token、密码、私有路径、服务名或非公开邮箱进入包、日志、文档或 Git metadata。
- 修复需要改变公开 v2 接口、认证政策、状态 schema、部署边界或 Story 意图。
- 任何 SEC/FUN 场景无可复现证据，或 cleanup 不能证明现有服务未受影响。

## 进度（2026-08-18）

- 验收发现 `lib/` 被 `.gitignore` 排除后，`npm pack` 只打出 15 个文件、没有 CLI。已增加 `.npmignore`（不忽略 `lib/`）和回归测试；修复后 tarball 77 files，`pack-smoke` 与 `installer-e2e` 退出 0。
- Chrome fragment 兑换在 `replaceState` 后发送 `Origin: null`。token POST 在有效 CSRF 且 `Sec-Fetch-Site` 为 same-origin/none/缺省时接受；密码登录与 logout 仍用精确同源。
- 锁定/latest Harness、password/login-token、Caddy manual+internal E2E 均退出 0。gitleaks 与 privacy 通过。Git 作者仅为批准公开身份与 Dependabot。
- 本地 packer 写入主包 `vendor/caddy` 双架构布局；`npm pack` 产出 82 files / 32.9 MB，含 x64+ARM64 Caddy。`pack-smoke` 与 `installer-e2e` 对 `dsh-auth-0.1.15.tgz` 离线通过，不注入第二包。独立平台包方案已撤销。
- live systemd：在现有 DSH Web 单元上卸载 v1 Nginx 安装后执行 v2 setup。`doctor --json` 退出 0；未认证 `/` 重定向到登录；公网 `/auth/verify` 为 404；loopback Harness 仍只监听本机；主机 Nginx `:80` 未改动。验收中修复 DynamicUser `STATE_DIRECTORY`、Caddyfile bind-mount 与 manual TLS 源证书校验。证据不记录主机标识、公网地址或秘密路径。
- SEC-26 / FUN-12 / FUN-10 已关闭。RELEASE 保持 0/1，直到 `dsh-auth@0.1.15` 出现在官方 npm 与 GitHub Release。不弃用 `0.1.14`，除非用户明确授权。

## 交接

交付 acceptance commit、全部命令/退出码、环境版本、SEC/FUN 固定分母、E2E artifact/checksum、system/container/reinstall 结果、pack 清单、秘密扫描、cleanup、Git 状态和发布阻塞。若未获用户明确授权，只提交分支并报告，不 push、不发布。
