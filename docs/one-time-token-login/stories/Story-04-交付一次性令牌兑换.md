---
kind: story
id: STORY-04
epic: EPIC-ONE-TIME-TOKEN-LOGIN
title: 交付一次性令牌兑换
status: done
gate: COMPONENT
owner: opencode
depends_on: [STORY-03]
blocker: 无
updated: 2026-08-18
intent_version: 1
---

# STORY-04：交付一次性令牌兑换

## 愿景

用户从云控制台一次点击即可换取正常管理员会话，同时链接预取、并发请求、日志和错误页面都不能泄漏或重复使用令牌。

## 范围

新增 fragment 桥接页面、同源 CSRF POST、令牌原子消费、统一失败页、独立限流和会话签发。管理员凭据设置页面留给下一 Story。技术路径见[执行卡](../agent/STORY-04-交付一次性令牌兑换执行卡.md)。

## 解决方案概览

- GET 页面不接收或消费令牌，浏览器脚本从 fragment 读取并先清除历史。
- 令牌通过受 CSRF 和 Origin 保护的表单 POST 到同源路由。
- 兑换用原子重命名抢占文件，先消费再创建会话。
- 无效、过期、已使用和格式错误统一显示同一友好页面。

## TODO

- [x] 实现安全的 fragment 桥接页面和无脚本降级提示。
- [x] 实现 CSRF、同源、请求上限和独立 IP 限流。
- [x] 实现原子消费、过期判定、失败清理和正常会话签发。
- [x] 实现内置及可选中英文纯文本失败文案。
- [x] 覆盖预取、并发兑换、重放、日志泄漏和开放跳转测试。

## 验收标准

- 登录 URL 使用 `/auth/token#token=…`；token 不进入查询字符串、Referer、访问日志或浏览器后续历史。
- 两个并发兑换最多一个成功；状态写入或会话创建失败后令牌仍不可重放。
- 无效、过期、已使用和格式错误均返回相同状态及文案结构，不形成状态探针。
- 自定义中英文文案各自最多 500 字符，拒绝控制字符和 HTML，并在输出时转义。
- 成功会话使用与密码登录相同的 Cookie、72 小时过期、滚动续期、撤销和 returnTo 校验。

## 交付证据

- 全量 132 项测试通过，含 token HTTP 12 项与浏览器桥接 3 项；`check`、`check:caddy`（tokenRoutes 公开代理、verify 仍 404）与 `git diff --check` 通过。
- 并发双 POST 仅一个 303；会话持久化失败后重放仍 401 且 consuming 文件保留；所有失败输出同形 no-store 页面且不含 token。
- 边缘默认 Referrer-Policy 改为缺省填充，token 页面的 no-referrer 不再被 Caddy 覆盖。
