# DSH 插件安装兼容

## 项目一览

本项目让官方 `dsh plugin --profile web add dsh-auth` 成为安全的预安装入口。该命令只把 bundle 加入 Web profile，不配置主机认证。未配置的 bundle 保持休眠，Web 继续正常启动。

管理员随后从受信任的全局 npm 安装取得 CLI，并运行 `sudo dsh-auth setup`。setup 验证 CLI 与 profile bundle 来自同一构建产物，再完成 Caddy、密钥、systemd 和认证状态配置。

已启用安装通过新的 `dsh-auth upgrade` 协调整体升级。普通 `dsh plugin` 更新造成的版本漂移会失败关闭。本项目只修改 `dsh-auth`，不包含插件市场或 DSH 上游改动。

项目负责人查看[《项目进展》](./项目进展.md)。

## Epic

- [EPIC-DSH-PLUGIN-INSTALL：DSH 插件安全预安装与受管生命周期](./epics/EPIC-DSH-PLUGIN-INSTALL.md)

## Agent 入口

执行 Agent 从项目进展选择首个可领取 Story，再从 [`agent/`](./agent/) 中读取与该 Story 同名的 JSON 执行卡。
