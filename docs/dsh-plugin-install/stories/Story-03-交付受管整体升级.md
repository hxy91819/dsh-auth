---
kind: story
id: STORY-03
epic: EPIC-DSH-PLUGIN-INSTALL
title: 交付受管整体升级
gate: COMPONENT
depends_on: [STORY-02]
updated: 2026-08-19
intent_version: 2
---

# STORY-03：交付受管整体升级

## 愿景

管理员用一个明确命令把运行时、Caddy、安装记录和服务升级到同一版本。失败升级不会留下混合版本或丢失认证状态。

## 范围

按 Epic「全局设计」新增 `dsh-auth upgrade` 的交互、非交互、JSON、计划、执行、验证和回滚契约。升级保留管理员凭据、session secret、认证状态和有效会话。它更新 setup 自装或接管的 bundle，并保持各自卸载语义。

## 关键决策

1. **整体升级使用独立的 upgrade 命令。**
   - 决定者：用户。
   - Agent 建议：曾建议复用 setup；用户选择新增独立命令。
   - 结果与影响：用户需学习一个新命令，但安装和升级意图更清楚。

2. **升级只接受健康的 schema v2 安装。**
   - 决定者：用户。
   - Agent 建议：不迁移 v1；用户采纳。
   - 结果与影响：v2 用户保留凭据和会话，v1 用户继续卸载重装。

3. **不允许主动降级，版本漂移失败关闭。**
   - 决定者：用户。
   - Agent 建议：只前进升级，失败时自动恢复；用户采纳。
   - 结果与影响：普通 `dsh plugin` 更新不能形成受支持的混合版本，必要时公网服务会停止而不是绕过认证边界。

## 验收标准

- upgrade 只接受包名、版本和构建身份与当前受信任全局 CLI 一致的目标，且目标版本必须高于安装版本；执行前展示无秘密计划。
- 成功升级后 bundle、Caddy、安装记录和服务版本一致。
- 管理员凭据、session secret、认证状态和有效会话保持可用。
- 任一步失败都恢复旧 bundle、Caddy、记录和服务状态。
- v1、降级、损坏状态和未受管安装在变更前被拒绝。
- doctor 识别版本漂移后，明确要求根据安装记录执行 `dsh plugin --profile <profile> add <package-spec>`，恢复匹配旧构建身份的 bundle；重新运行 doctor 确认健康；再运行 upgrade。
- 旧产物不可用或恢复后的构建身份不匹配时，doctor 保持失败，upgrade 不接受该安装。
