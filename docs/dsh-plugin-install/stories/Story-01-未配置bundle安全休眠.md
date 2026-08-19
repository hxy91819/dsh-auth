---
kind: story
id: STORY-01
epic: EPIC-DSH-PLUGIN-INSTALL
title: 未配置 bundle 安全休眠
gate: COMPONENT
depends_on: []
updated: 2026-08-19
intent_version: 1
---

# STORY-01：未配置 bundle 安全休眠

## 愿景

用户通过官方 DSH 插件命令加入 dsh-auth 后，现有 Web 继续正常启动。预安装不会被误认为认证已经启用。

## 范围

按 Epic「全局设计」实现 Cordis row 的休眠条件，并验证 Host 与客户端都没有插件效果。两个核心变量全部缺失时休眠；仅缺一个时保留严格配置错误；完整配置继续启用现有认证。

## 关键决策

1. **官方 DSH 插件安装是安全预安装，不是完整认证部署。**
   - 决定者：用户。
   - Agent 建议：缺少全部核心配置时让 bundle 休眠；用户采纳。
   - 结果与影响：`dsh plugin add` 不再打挂 Web，但管理员仍必须运行全局 CLI 的 setup。

2. **部分核心配置继续失败。**
   - 决定者：用户。
   - Agent 建议：只在两个核心变量都不存在时休眠；用户采纳。
   - 结果与影响：新预安装可安全启动，已损坏的部署不会被静默掩盖。

## 验收标准

- 无核心变量的打包 bundle 加入真实 Web profile 后，Web 可以启动。
- 休眠 bundle 不注册认证路由、不修改首页，也不提供认证设置 UI。
- 仅提供一个核心变量时，启动返回清楚的配置错误。
- 完整受管配置继续启用原有认证行为和安全校验。

