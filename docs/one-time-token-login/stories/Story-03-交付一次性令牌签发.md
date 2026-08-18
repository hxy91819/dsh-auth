---
kind: story
id: STORY-03
epic: EPIC-ONE-TIME-TOKEN-LOGIN
title: 交付一次性令牌签发
status: todo
gate: COMPONENT
owner: 待领取
depends_on: [STORY-02]
blocker: 无
updated: 2026-08-18
intent_version: 1
---

# STORY-03：交付一次性令牌签发

## 愿景

让云托管商通过受控的实例内命令取得一个短期登录链接，同时确保 bearer secret 不进入参数、磁盘明文、计划、诊断或错误。

## 范围

新增 `issue-login-token`，覆盖受管 systemd 自动发现和容器显式状态路径。实现随机令牌、摘要文件、期限、并发上限、过期清理、授权和 JSON 输出。HTTP 兑换留给后续 Story。技术路径见[执行卡](../agent/STORY-03-交付一次性令牌签发执行卡.md)。

## 解决方案概览

- 每次签发生成带版本前缀的 256 位随机令牌。
- 磁盘只保存 SHA-256 摘要命名的单令牌元数据文件。
- 默认有效期五分钟，可缩短；最多保留 32 个未过期令牌。
- stdout 返回登录 URL，JSON 明确标记唯一的 bearer secret 输出例外。

## TODO

- [ ] 实现令牌格式、摘要元数据、原子创建和过期清理。
- [ ] 实现 systemd 与容器两种受限的状态和 public origin 解析。
- [ ] 实现 TTL、容量、所有者、权限和授权校验。
- [ ] 冻结人读输出、JSON v2 和失败诊断。
- [ ] 验证并发签发、随机冲突、输出失败和恶意路径。

## 验收标准

- TTL 默认 300 秒，只允许 60–300 秒；第 33 个有效令牌被拒绝。
- 原始令牌只出现在成功 stdout/JSON 和最终 fragment URL 中，磁盘与失败输出均不含明文。
- systemd 仅 root 可签发；容器仅 root 或认证状态唯一所有者可签发。
- 容器必须同时提供安全的认证状态文件和单一 public origin；路径、符号链接或权限异常时失败关闭。
- 并发签发不会覆盖已有令牌，清理只删除严格匹配且已过期的受管文件。
