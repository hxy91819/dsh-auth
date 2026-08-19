---
kind: story
id: STORY-04
epic: EPIC-DSH-PLUGIN-INSTALL
title: 完成安装生命周期验收
gate: RELEASE
depends_on: [STORY-03]
updated: 2026-08-19
intent_version: 2
---

# STORY-04：完成安装生命周期验收

## 愿景

维护者可以依据同一份发布证据判断官方插件预安装、setup、upgrade、doctor、回滚和 uninstall 是否形成完整且安全的生命周期。

## 范围

按 Epic「全局设计」完成真实 DSH、打包产物、Caddy、systemd 和浏览器验收。更新公共安装说明、安装器架构、安全边界、发布检查和故障修复说明。本 Story 不修改 DSH 上游或插件市场。

## 关键决策

1. **本项目只交付 dsh-auth 内的官方插件安装兼容。**
   - 决定者：用户。
   - Agent 建议：不把外部市场状态作为本 Epic 的前置；用户采纳并明确不考虑市场。
   - 结果与影响：发布不依赖外部系统，但公共文档必须明确 `dsh plugin add` 之后仍需全局 CLI 和 setup。

2. **继续使用一个包含 Caddy 的 npm 包。**
   - 决定者：用户。
   - Agent 建议：无，用户直接决定保留既有设计。
   - 结果与影响：包体积不在本项目优化范围；在线、私有镜像和离线安装继续使用同一发布物。

## 验收标准

- 打包产物完成“插件预安装、休眠、setup 接管、doctor、upgrade、uninstall、再次休眠”的真实生命周期。
- setup 自装与外部预装两条路径都验证成功、失败和清理结果。
- 升级成功、自动回滚、拒绝降级，以及“版本漂移、恢复旧 bundle、doctor 恢复健康、再升级”的路径均有可重复证据。
- Caddy 公网边界、loopback、下载、SSE、WebSocket、会话和秘密规则没有回归。
- 公共文档用普通语言区分“已预安装”和“认证已启用”。
- 全量检查、Caddy 检查、真实 E2E、打包检查和差异检查全部通过。
