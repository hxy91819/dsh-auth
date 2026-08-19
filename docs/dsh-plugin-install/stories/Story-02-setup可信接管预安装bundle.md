---
kind: story
id: STORY-02
epic: EPIC-DSH-PLUGIN-INSTALL
title: setup 可信接管预安装 bundle
gate: COMPONENT
depends_on: [STORY-01]
updated: 2026-08-19
intent_version: 1
---

# STORY-02：setup 可信接管预安装 bundle

## 愿景

管理员可以在官方 DSH 插件安装之后运行 setup，而不需要先手工删除 bundle。接管不会放宽 root 安装器对包内容和主机文件的信任检查。

## 范围

按 Epic「全局设计」增加稳定构建身份，验证全局 CLI 与实际解析到的 profile bundle。setup 对匹配的预安装包跳过重复安装，并明确记录外部来源。版本、构建身份、bundle 声明或解析来源不匹配时不修改主机。

## 关键决策

1. **接管要求同一构建产物。**
   - 决定者：用户。
   - Agent 建议：比较包名、版本和构建身份，而不是只比较版本；用户采纳。
   - 结果与影响：registry、私有镜像和 tarball 可以使用同一契约，但同版本的不同内容不能进入 root 认证边界。

2. **预安装 bundle 保留外部所有权。**
   - 决定者：用户。
   - Agent 建议：setup 只接管运行配置，不取得删除权；用户采纳。
   - 结果与影响：失败回滚和 uninstall 保留该 bundle，清除受管配置后它恢复休眠。

## 验收标准

- 同一构建的预安装 bundle 可以完成 setup，且不会再次执行插件安装。
- 非同一构建、错误声明或异常解析来源在任何主机变更前失败。
- setup 自行安装的 bundle 与外部预安装 bundle 使用不同的卸载语义。
- 接管失败、激活失败和卸载都不会删除外部预安装 bundle。
- 既有密钥、systemd 和其他未归属文件仍按原规则拒绝覆盖。

