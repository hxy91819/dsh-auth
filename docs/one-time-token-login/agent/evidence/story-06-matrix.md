# STORY-06 验收矩阵

- Candidate：单包发布决策后的 acceptance commit 待回填；旧候选 `4b26ad2621c0e8696cb3257a6fa73acb968731f9` 已失效
- 锁定 / npm latest Harness：`0.1.0-rc.7`
- Caddy：`v2.11.4` / 包装 `dsh.1`
- 状态：用户已否决独立平台包。下列历史命令只用于定位回归，全部场景必须在新的自包含主 tarball 上复验后才能通过

## 环境

| 项目 | 值 |
| --- | --- |
| Node | v24.15.0 |
| pnpm | 10.14.0 |
| OpenSSL | 3.0.12 |
| Chrome | /usr/bin/google-chrome |
| systemd | 255 |
| Git authors | `masonxhuang@proton.me`、Dependabot |

## 已撤销的历史命令

| 命令 | 退出码 |
| --- | ---: |
| `corepack pnpm run check` | 0（140 tests，旧发布模型，不计入新验收） |
| `corepack pnpm run check:caddy` | 0 |
| `corepack pnpm run test:e2e`（login-token） | 0 |
| `DSH_E2E_BOOTSTRAP=password corepack pnpm run test:e2e` | 0 |
| `corepack pnpm run test:e2e:latest-dsh` | 0 |
| `corepack pnpm run test:e2e:caddy` | 0（manual + internal） |
| `npm pack` + `pack-smoke` + `installer-e2e` | 0（旧 tarball 不含双架构 Caddy，结果撤销） |
| `corepack pnpm run pack:caddy` | 0（只生成独立布局，结果撤销） |
| `node scripts/release-validation.mjs privacy` | 0 |
| `gitleaks detect --source . --no-git` | 0 |
| `git log` 作者扫描 | 仅批准公开身份与 Dependabot |

## 矩阵

| ID | 证据路径 | 状态 |
| --- | --- | --- |
| SEC-01 | `tests/login-token-http.spec.ts`、`tests/browser-bootstrap.spec.ts`、真实 E2E token 旅程 | 待新候选复验 |
| SEC-02 | `tests/login-token-store.spec.ts`、gitleaks、privacy | 待新候选复验 |
| SEC-03 | `tests/login-token-http.spec.ts` 并发 POST | 待新候选复验 |
| SEC-04 | `tests/login-token-http.spec.ts` 过期/重放 | 待新候选复验 |
| SEC-05 | `tests/login-token-http.spec.ts` GET/HEAD 不消费 | 待新候选复验 |
| SEC-06 | `tests/login-token-http.spec.ts` Origin/CSRF；Chrome `Origin: null` 在有效 CSRF 下通过 | 待新候选复验 |
| SEC-07 | `tests/login-token-http.spec.ts`、`tests/auth-http.spec.ts` returnTo | 待新候选复验 |
| SEC-08 | `tests/login-token-http.spec.ts` 限流与 413；真实 E2E oversized 413 | 待新候选复验 |
| SEC-09 | `tests/installer-system.spec.ts`、`tests/caddy-installer.spec.ts`、`tests/installer-cli.spec.ts` 路径攻击 | 待新候选复验 |
| SEC-10 | `tests/installer-cli.spec.ts` 签发授权 | 待新候选复验 |
| SEC-11 | `tests/login-token-store.spec.ts` TTL/容量 | 待新候选复验 |
| SEC-12 | `tests/login-token-store.spec.ts` 冲突/失败 | 待新候选复验 |
| SEC-13 | `tests/login-token-http.spec.ts` 文案转义 | 待新候选复验 |
| SEC-14 | `tests/admin-onboarding.spec.ts` 并发 POST | 待新候选复验 |
| SEC-15 | `tests/admin-onboarding.spec.ts` 三会话撤销 | 待新候选复验 |
| SEC-16 | `tests/password.spec.ts`、`tests/admin-onboarding.spec.ts` | 待新候选复验 |
| SEC-17 | `tests/session-persistence.spec.ts` 故障注入 | 待新候选复验 |
| SEC-18 | `tests/installer-system.spec.ts` reset 停服务 | 待新候选复验 |
| SEC-19 | `tests/session-persistence.spec.ts` secret 轮换 | 待新候选复验 |
| SEC-20 | `tests/installer-cli.spec.ts` schema v1 拒绝 | 待新候选复验 |
| SEC-21 | `tests/installer-cli.spec.ts` 输出扫描；installer-e2e 不回显密码 | 待新候选复验 |
| SEC-22 | `check:caddy`、真实 E2E 公网边界 | 待新候选复验 |
| SEC-23 | `tests/auth-http.spec.ts`、真实 E2E Cookie | 待新候选复验 |
| SEC-24 | 真实 E2E 重启；`tests/login-token-store.spec.ts` | 待新候选复验 |
| SEC-25 | `npm pack` 77 files、gitleaks、privacy、Git authors | 待新候选复验 |
| SEC-26 | 主 tarball 双架构清单；缺失、篡改、错架构和离线安装 | 待新候选复验 |
| FUN-01 | installer-system/cli；真实 E2E password 旅程 | 待新候选复验 |
| FUN-02 | `tests/installer-cli.spec.ts` login-token setup；真实 E2E token 旅程 | 待新候选复验 |
| FUN-03 | `tests/login-token-http.spec.ts`、`tests/installer-cli.spec.ts` | 待新候选复验 |
| FUN-04 | `tests/admin-onboarding.spec.ts`；真实 E2E token 设置 | 待新候选复验 |
| FUN-05 | `tests/admin-onboarding.spec.ts` Later；真实 E2E | 待新候选复验 |
| FUN-06 | `tests/login-token-http.spec.ts`、`tests/admin-onboarding.spec.ts` | 待新候选复验 |
| FUN-07 | `tests/installer-cli.spec.ts` systemd 签发 | 待新候选复验 |
| FUN-08 | 真实 E2E `containerTokenIssue: json v2` | 待新候选复验 |
| FUN-09 | `tests/login-token-http.spec.ts` | 待新候选复验 |
| FUN-10 | `tests/installer-cli.spec.ts` v1 拒绝；未做会改写主机 `/etc` 的 live systemd 重装 | 待新候选复验 |
| FUN-11 | `test:e2e:latest-dsh` 退出 0，Harness `0.1.0-rc.7` | 待新候选复验 |
| FUN-12 | 一个主 tarball 同时携带 x64/arm64，安装器只选择当前架构且不联网 | 待新候选复验 |
| FUN-13 | `test:e2e:caddy` manual + internal，HTTP/2 200 | 待新候选复验 |

## 发布阻塞

1. 新候选尚未证明唯一主 tarball 同时包含两种架构 Caddy、manifest、checksum 与许可证，也未证明单文件离线安装。
2. installer、doctor、rollback、release workflow 和公开文档尚未在同一候选上完成单包模型复验。
3. 未在可丢弃主机完成真实 systemd setup、卸载重装和失败恢复；不得在现有部署上补做该证据。
