---
kind: epic
id: EPIC-DSH-PLUGIN-INSTALL
title: DSH 插件安全预安装与受管生命周期
updated: 2026-08-19
coverage: [DORMANT_BUNDLE, TRUSTED_ADOPTION, MANAGED_UPGRADE, LIFECYCLE_ACCEPTANCE]
---

# Epic：DSH 插件安全预安装与受管生命周期

## 愿景

官方 `dsh plugin add` 可以预安装 dsh-auth，而不会让 Web 在下一次启动时失败。管理员仍通过 dsh-auth 的受管命令完成主机配置和后续升级。安装来源、运行版本、Caddy 和卸载结果始终可以解释和验证。

## 全局设计

**能力一：安全预安装。**

两个核心认证文件变量都不存在时，Cordis row 保持禁用。插件不注册路由，不修改页面，也不加载客户端功能。只缺一个变量表示部署损坏，Web 启动继续明确失败。

```text
dsh plugin add
      |
      v
profile bundle 已存在
      |
      +-- 两个核心变量都不存在 --> bundle 休眠 --> Web 正常启动
      +-- 只存在一个变量 --------> 配置错误 --> 明确失败
      +-- 两个变量都存在 --------> 正常认证运行
```

**能力二：可信接管。**

管理员从 root 信任的位置运行全局 CLI。setup 比较 CLI 与 profile bundle 的包名、版本和构建身份。只有同一构建产物可以被接管。setup 不取得预装 bundle 的删除权；失败回滚和 uninstall 都保留它，使它回到休眠状态。

```text
全局 CLI + 预装 bundle
          |
          v
  构建身份与主机检查
          |
          +-- 不匹配 --> 不改主机并给出诊断
          +-- 匹配 ----> setup 配置密钥、Caddy、systemd 和认证状态
```

**能力三：受管升级。**

新的 `dsh-auth upgrade` 只处理健康的 schema v2 安装。目标包名、版本和构建身份必须与当前受信任的全局 CLI 一致，且目标版本必须高于安装版本。它把 profile bundle、Caddy、安装记录和服务更新为该目标构建，并保留管理员凭据和会话。它不迁移 v1，也不主动降级。失败时恢复升级前版本。

```text
健康的 v2 安装 --> upgrade 计划 --> 原子更新并验证 --> 新版本运行
                               |
                               +-- 失败 --> 恢复旧版本
```

绕过 upgrade 单独更新 bundle 会产生版本漂移。运行时失败关闭，upgrade 拒绝损坏状态。doctor 必须给出固定恢复顺序：根据安装记录执行 `dsh plugin --profile <profile> add <package-spec>`，恢复匹配旧构建身份的 bundle；重新运行 doctor 确认健康；再运行 upgrade。旧产物不可用或身份不匹配时继续失败关闭。

## 成功标准

| 门禁 | Epic 成功条件 |
| --- | --- |
| READY | 已确认两阶段安装、构建身份、所有权和升级边界；真实 DSH 行为可复现 |
| COMPONENT | 安全休眠、可信接管和受管升级分别通过行为、安全、回滚与代码质量检查 |
| RELEASE | 完整生命周期在打包产物和真实 DSH 上通过，公开文档准确说明用户必须执行的步骤 |

## Story 地图

| Story | 交付结果 |
| --- | --- |
| [STORY-01 未配置 bundle 安全休眠](../stories/Story-01-未配置bundle安全休眠.md) | 官方插件安装后 Web 保持可用，损坏配置仍明确失败 |
| [STORY-02 setup 可信接管预安装 bundle](../stories/Story-02-setup可信接管预安装bundle.md) | 同一构建产物可被接管，外部所有权在回滚和卸载后保留 |
| [STORY-03 交付受管整体升级](../stories/Story-03-交付受管整体升级.md) | v2 安装通过独立命令安全升级并可自动恢复 |
| [STORY-04 完成安装生命周期验收](../stories/Story-04-完成安装生命周期验收.md) | 打包、真实 DSH、systemd、文档和漂移诊断形成发布证据 |

## 项目边界

- 继续发布一个 npm 包，并保留包内的 x64 与 ARM64 Caddy。
- `dsh plugin add` 只是预安装，不创建密钥、不安装 Caddy，也不启用认证。
- setup 与 upgrade 必须从 root 信任的位置运行；不得以 root 执行 profile 内可能被服务用户修改的 CLI。
- 不修改 DSH 上游或任何插件市场，不使用 npm postinstall 配置主机。
- 不迁移 schema v1，不支持主动降级，不放宽现有密钥、路径和公网认证边界。

## 权威文档

- [公共安装说明](../../../README.md)
- [安装器架构](../../installer.md)
- [安全边界](../../../SECURITY.md)
- [动态项目进展](../项目进展.md)
