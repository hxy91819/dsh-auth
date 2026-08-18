---
kind: story
id: STORY-06
epic: EPIC-ONE-TIME-TOKEN-LOGIN
title: 完成企业版发布验收
status: in_progress
gate: RELEASE
owner: Cursor
depends_on: [STORY-05]
blocker: 无
updated: 2026-08-18
intent_version: 3
---

# STORY-06：完成企业版发布验收

## 愿景

让用户只安装和保存一份 `dsh-auth` 发布包，就能得到包含受管 Caddy 的完整产品；维护者和云托管商可以凭同一套证据判断它是否可发布、可离线部署和可安全恢复。

## 范围

修正已经发布但无法独立完成安装的拆包方案，交付一个自包含主包和一个同版本 GitHub Release。在验收时的 npm latest Harness 上完成安装、离线分发、真实 E2E、Caddy、公开文档和供应链检查。旧版本不能覆盖，只能发布新的修复版本；旧安装仍采用卸载重装。详细步骤见[执行卡](../agent/STORY-06-完成企业版发布验收执行卡.md)。

## 解决方案概览

- npm 和 GitHub 都只发布 `dsh-auth` 主包；不再要求用户寻找或安装其他 Caddy 包。
- 主包同时携带 Linux x64 和 ARM64 的官方 Caddy，安装器在本地选择当前架构并验证完整性，全程不下载二进制。
- 接受主包体积增大，以换取单文件归档、私有镜像和离线安装都能独立工作。
- 缺失、篡改或架构不匹配必须在修改系统前失败，并保留安全回滚能力。
- 锁定和 npm latest Harness、两种 TLS、systemd、容器及完整登录旅程使用同一发布候选复验。

## TODO

- [ ] 生成只包含一个主包的发布候选，并确认其中同时包含两种架构的 Caddy 与许可证。
- [ ] 完成架构选择、完整性失败、单文件离线安装和回滚验收。
- [ ] 完成 systemd、容器、两种 TLS、doctor、uninstall 和重装验收。
- [ ] 在同一候选上重跑锁定/latest Harness、真实浏览器、Caddy 和全部安全场景。
- [ ] 更新公开文档并完成包内容、Git 元数据、日志和秘密扫描，形成发布结论。

## 验收标准

- 用户只需安装或归档一个 `dsh-auth` 包；npm 和 GitHub Release 不再有独立 Caddy 发布物。
- 同一主包包含两种受支持架构的官方 Caddy、来源信息、校验材料和许可证；安装器只复制当前架构。
- 单独复制主包到无网络环境后仍能完成安装；缺失、篡改和错误架构均在系统变更前失败。
- systemd 与容器均能签发和兑换令牌；两种 TLS、服务重启、状态写入失败和回滚结果明确。
- 锁定/latest Harness、全部安全矩阵、公开文档、包内容和秘密扫描都来自同一 acceptance commit。
- SEC 26/26、FUN 13/13、COMPONENT 6/6、RELEASE 1/1 在新发布模型复验后关闭。
