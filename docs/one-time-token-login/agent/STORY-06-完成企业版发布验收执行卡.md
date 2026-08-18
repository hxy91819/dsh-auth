---
story: STORY-06
intent_version: 3
refreshed: 2026-08-18
code_baseline: f232dc2ae1a5a10815514477e4efca12d2a0a1f5
owns: [RELEASE_ACCEPTANCE]
verifies: [AUTH_STATE, EDGE_RUNTIME, INSTALLER_V2, TOKEN_ISSUANCE, TOKEN_REDEMPTION, ADMIN_ONBOARDING]
---

# STORY-06 完成企业版发布验收执行卡

- 状态：进行中（2026-08-18，Cursor，feature/story-06-release-acceptance）
- 对应：[STORY-06 完成企业版发布验收](../stories/Story-06-完成企业版发布验收.md)

## 目标与完成信号

在验收时的 npm latest Harness 和一个 acceptance commit 上交付唯一的 `dsh-auth` 主 tarball。该 tarball 同时包含 Linux x64/ARM64 Caddy，能够单独归档和离线安装，并作为 npm 包与唯一 GitHub Release 资产使用。完成信号是主包、安装器、全量矩阵和公开文档使用同一发布模型，COMPONENT 恢复 6/6，RELEASE 达到 1/1。

## 决策边界

- 人读 Story 已确认一个 npm 主包、一个 GitHub Release；不发布或解析 `dsh-auth-caddy-*`，不使用 optional dependency。
- 主包必须同时携带两种受支持架构，接受包体积增加以换取独立安装、私有镜像和离线归档。
- setup、preinstall、postinstall 均不得联网下载 Caddy；Release preflight 可以在隔离 staging 中取得固定官方归档。
- 安装器只执行当前架构二进制，但发布前必须验证两份二进制、manifest、checksum 和许可证完整。
- `dsh-auth@0.1.14` 已发布且内容不可覆盖；只能用新的补丁版本向前修复，不移动旧 tag。
- 旧版仍只支持显式卸载重装，不新增迁移脚本；未获授权不 push、不发布、不 deprecate。

## 技术方案

Release preflight 从固定 Caddy `v2.11.4` 官方归档准备 `vendor/caddy/` staging，校验上游摘要后生成双架构二进制、项目 manifest、manifest checksum、LICENSE 和 THIRD_PARTY。把该目录注入同一个 `dsh-auth` tarball；所有后续 job 只传递并复验这一份 tarball及其 SHA-256。

installer 从自身包根解析 `vendor/caddy`，按 `process.platform/process.arch` 选择当前二进制，验证 manifest、版本、目标 SHA-256 和许可证后复制到受管路径。缺失任一受支持架构、当前架构不支持、错架构、版本漂移或篡改都在系统变更前失败。doctor 和 rollback 继续检查复制后的受管版本与 checksum。

真实验收在同一候选上覆盖锁定/latest Harness、password/login-token、fragment 兑换、首次设置、续期、logout、重启、Caddy automatic/manual TLS、systemd、容器、doctor、uninstall 和 v1 重装。旧拆包模型产生的 package/E2E 结果只作历史诊断，不计入新 acceptance commit。

## 权威输入

- [人读 Story](../stories/Story-06-完成企业版发布验收.md)、[Epic](../epics/EPIC-ONE-TIME-TOKEN-LOGIN.md)、[门禁](./门禁.md)、[安全矩阵](./安全威胁与验收矩阵.md)。
- [核心决策](./核心决策.md) D-20、[接口与参数契约](./接口与参数契约.md)的 Caddy 主包分发章节。
- 仓库 `AGENTS.md`、`SECURITY.md`、`README.md`、`docs/installer.md`、`docs/releasing.md`。
- 验证入口：`check`、`check:caddy`、`test:e2e`、`test:e2e:latest-dsh`、installer/pack/release validation tests。

## 领取检查

确认 STORY-01 至 05 的认证和边缘结果仍可复现，COMPONENT 只因 INSTALLER_V2 的发布来源变化降为 5/6。再次读取 npm latest Harness；不同于锁定版时先刷新基线。检查主仓、相关 worktree 和状态，确认没有覆盖其他 Agent 的发布实现。记录候选 commit、Node/pnpm、Caddy、浏览器与两份官方归档摘要后再开始长测试。

领取记录（2026-08-18）：

- npm latest `@deepseek-ai/dsh` 与锁定版均为 `0.1.0-rc.7`；Caddy 固定 `v2.11.4`。
- `dsh-auth@0.1.14` 已发布，但主包没有 Caddy optional dependency，原计划的两个平台包也未发布，正式安装链不完整。
- 用户明确否决独立平台包，确认主包内置双架构 Caddy、单 npm 包、单 GitHub Release 和安装期零下载。
- 原 STORY-06 package、SEC-26、FUN-12 和 RELEASE 证据已撤销；其他历史测试结果必须在新候选上复跑。

## 执行步骤

1. 冻结双架构官方输入与主包目录，先写失败测试证明旧 tarball 不自包含。
2. 让打包器和 release preflight 生成唯一主 tarball，并对两架构内容、许可证和 manifest 做确定性校验。
3. 将 installer/doctor/rollback 改为从主包选择当前架构，覆盖缺失、篡改、错架构、不支持平台和系统变更前失败。
4. 从仅有主 tarball 的隔离、无网络环境运行 pack smoke、CLI/PTY installer E2E、systemd/container/TLS 和卸载重装。
5. 在同一候选上运行锁定/latest Harness、真实浏览器和安全矩阵；任何修复后从受影响入口重新验收。
6. 更新公开安装/发布文档，扫描 tarball、日志、文件和 Git metadata；全部分母关闭后才能形成发布结论。

## 验证与证据

```bash
corepack pnpm run check
corepack pnpm run check:caddy
corepack pnpm run test:e2e
corepack pnpm run test:e2e:latest-dsh
npm pack --dry-run
git diff --check
```

额外证据必须列出唯一 tarball 文件清单和 SHA-256、两架构 Caddy 版本/摘要/许可证、单文件离线安装、当前架构选择、缺失/篡改/错架构失败、systemd/container/TLS、doctor/rollback/uninstall、gitleaks、privacy 和 cleanup。任何旧平台包测试都不能作为通过证据。

## 停止条件

- 需要恢复独立平台包、运行时下载、第二个 npm/GitHub Release 或复用系统网关。
- Release staging 与本地 pack 不能生成字节和 manifest 语义一致的主 tarball。
- 任一受支持架构缺少可验证的官方归档、许可证或 checksum。
- 候选提交、npm latest、Caddy 输入或发布包在验收期间变化。
- 任一 token、密码、私有路径、服务名或非公开邮箱进入包、日志、文档或 Git metadata。
- 任何 SEC/FUN 场景无可复现证据，或 cleanup 不能证明现有服务未受影响。

## 交接

交付新的 acceptance commit、唯一主 tarball及摘要、两架构 Caddy 输入、全部命令/退出码、SEC/FUN 固定分母、system/container/reinstall 结果、秘密扫描、cleanup、Git 状态和发布阻塞。明确 `0.1.14` 只能向前修复；除非用户另行授权，不执行 npm/GitHub 发布、deprecate 或 push。
