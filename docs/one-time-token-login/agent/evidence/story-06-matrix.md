# STORY-06 验收矩阵

- Candidate：`4b26ad2621c0e8696cb3257a6fa73acb968731f9`（领取基线）；acceptance commit 待关闭 RELEASE 时回填
- 锁定 / npm latest Harness：`0.1.0-rc.7`
- Caddy：`v2.11.4` / 包装 `dsh.1`
- 状态：同一工作树上的命令、退出码与产物；未关闭项保持未通过

## 环境

| 项目 | 值 |
| --- | --- |
| Node | v24.15.0 |
| pnpm | 10.14.0 |
| OpenSSL | 3.0.12 |
| Chrome | /usr/bin/google-chrome |
| systemd | 255 |
| Git authors | `masonxhuang@proton.me`、Dependabot |

## 已复跑命令

| 命令 | 退出码 |
| --- | ---: |
| `corepack pnpm run check` | 0（140 tests，领取后改动前） |
| `corepack pnpm run check:caddy` | 0 |
| `corepack pnpm run test:e2e`（login-token） | 0 |
| `DSH_E2E_BOOTSTRAP=password corepack pnpm run test:e2e` | 0 |
| `corepack pnpm run test:e2e:latest-dsh` | 0 |
| `corepack pnpm run test:e2e:caddy` | 0（manual + internal） |
| `npm pack` + `pack-smoke` + `installer-e2e` | 0（82 files，含 `lib/cli.js` 与双架构 `vendor/caddy`） |
| `corepack pnpm run pack:caddy -- --clean` | 主包 vendor 布局；跨架构只核 SHA |
| `node scripts/release-validation.mjs privacy` | 0 |
| `gitleaks detect --source . --no-git` | 0 |
| `git log` 作者扫描 | 仅批准公开身份与 Dependabot |

## 矩阵

| ID | 证据路径 | 状态 |
| --- | --- | --- |
| SEC-01 | `tests/login-token-http.spec.ts`、`tests/browser-bootstrap.spec.ts`、真实 E2E token 旅程 | 已验证 |
| SEC-02 | `tests/login-token-store.spec.ts`、gitleaks、privacy | 已验证 |
| SEC-03 | `tests/login-token-http.spec.ts` 并发 POST | 已验证 |
| SEC-04 | `tests/login-token-http.spec.ts` 过期/重放 | 已验证 |
| SEC-05 | `tests/login-token-http.spec.ts` GET/HEAD 不消费 | 已验证 |
| SEC-06 | `tests/login-token-http.spec.ts` Origin/CSRF；Chrome `Origin: null` 在有效 CSRF 下通过 | 已验证 |
| SEC-07 | `tests/login-token-http.spec.ts`、`tests/auth-http.spec.ts` returnTo | 已验证 |
| SEC-08 | `tests/login-token-http.spec.ts` 限流与 413；真实 E2E oversized 413 | 已验证 |
| SEC-09 | `tests/installer-system.spec.ts`、`tests/caddy-installer.spec.ts`、`tests/installer-cli.spec.ts` 路径攻击 | 已验证 |
| SEC-10 | `tests/installer-cli.spec.ts` 签发授权 | 已验证 |
| SEC-11 | `tests/login-token-store.spec.ts` TTL/容量 | 已验证 |
| SEC-12 | `tests/login-token-store.spec.ts` 冲突/失败 | 已验证 |
| SEC-13 | `tests/login-token-http.spec.ts` 文案转义 | 已验证 |
| SEC-14 | `tests/admin-onboarding.spec.ts` 并发 POST | 已验证 |
| SEC-15 | `tests/admin-onboarding.spec.ts` 三会话撤销 | 已验证 |
| SEC-16 | `tests/password.spec.ts`、`tests/admin-onboarding.spec.ts` | 已验证 |
| SEC-17 | `tests/session-persistence.spec.ts` 故障注入 | 已验证 |
| SEC-18 | `tests/installer-system.spec.ts` reset 停服务 | 已验证 |
| SEC-19 | `tests/session-persistence.spec.ts` secret 轮换 | 已验证 |
| SEC-20 | `tests/installer-cli.spec.ts` schema v1 拒绝 | 已验证 |
| SEC-21 | `tests/installer-cli.spec.ts` 输出扫描；installer-e2e 不回显密码 | 已验证 |
| SEC-22 | `check:caddy`、真实 E2E 公网边界 | 已验证 |
| SEC-23 | `tests/auth-http.spec.ts`、真实 E2E Cookie | 已验证 |
| SEC-24 | 真实 E2E 重启；`tests/login-token-store.spec.ts` | 已验证 |
| SEC-25 | `npm pack` 82 files（含双架构 Caddy）、gitleaks、privacy、Git authors | 已验证 |
| SEC-26 | `tests/caddy-installer.spec.ts`；`dsh-auth-0.1.15.tgz` 含 vendor/caddy；pack-smoke 离线 setup 通过；未 npm 发布 | 进行中 |
| FUN-01 | installer-system/cli；真实 E2E password 旅程 | 已验证 |
| FUN-02 | `tests/installer-cli.spec.ts` login-token setup；真实 E2E token 旅程 | 已验证 |
| FUN-03 | `tests/login-token-http.spec.ts`、`tests/installer-cli.spec.ts` | 已验证 |
| FUN-04 | `tests/admin-onboarding.spec.ts`；真实 E2E token 设置 | 已验证 |
| FUN-05 | `tests/admin-onboarding.spec.ts` Later；真实 E2E | 已验证 |
| FUN-06 | `tests/login-token-http.spec.ts`、`tests/admin-onboarding.spec.ts` | 已验证 |
| FUN-07 | `tests/installer-cli.spec.ts` systemd 签发 | 已验证 |
| FUN-08 | 真实 E2E `containerTokenIssue: json v2` | 已验证 |
| FUN-09 | `tests/login-token-http.spec.ts` | 已验证 |
| FUN-10 | `tests/installer-cli.spec.ts` v1 拒绝；未做会改写主机 `/etc` 的 live systemd 重装 | 部分 |
| FUN-11 | `test:e2e:latest-dsh` 退出 0，Harness `0.1.0-rc.7` | 已验证 |
| FUN-12 | 本地 `dsh-auth-0.1.15.tgz` 离线 pack-smoke/installer-e2e 通过，不需要第二包；未 npm 发布 | 进行中 |
| FUN-13 | `test:e2e:caddy` manual + internal，HTTP/2 200 | 已验证 |

## 发布阻塞

1. `dsh-auth@0.1.14` 仍要求不存在的独立 Caddy 平台包。用户已确认改为主包自包含双架构 Caddy，向前发布 `0.1.15`；未授权前不 npm/GitHub 发布、不弃用 `0.1.14`。
2. 未在本机执行会写入 `/etc/dsh-auth` 并启停真实单元的 systemd setup；`docs/installer.md` 要求用可丢弃 output-dir，不碰已部署公网端口。FUN-10 live 重装因此保持部分。
