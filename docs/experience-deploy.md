# Experience environment deployment

`.github/workflows/experience-deploy.yml` is a manual, non-release deployment path. It packages a reviewed ref whose tip is already reachable from `main`, creates a temporary `X.Y.(Z+1)-experience.<run-id>.<attempt>` prerelease, and uploads that tarball directly to one protected GitHub Environment. The prerelease is never published to npm and exists only because the managed `upgrade` command requires a strictly newer version. The workflow rejects unmerged commits before any deployment secret is loaded.

The workflow uses the same tarball for the global CLI and the DSH profile bundle. It keeps every uploaded, non-secret tarball under `/var/lib/dsh-auth-experience/artifacts/`; the directory is traversable by the DSH service account so `dsh plugin` can read it. Do not delete the artifact recorded by `/etc/dsh-auth/install-state.json`, because the installer uses it for offline rollback. The workflow does not run `dsh plugin` independently and does not touch a user-managed Caddy or Nginx service.

## GitHub Environment

Create an environment named exactly `dsh-experience`. Restrict deployments to `main` and require an approval rule for every deployment. The workflow itself must be dispatched from `main`; its `ref` input selects a branch, tag, or commit whose tip is already reachable from `main`. The workflow verifies that ancestry before loading deployment secrets. Configure these environment variables:

| Name | Required | Example/default | Purpose |
|---|---|---|---|
| `DSH_EXPERIENCE_SSH_HOST` | yes | `203.0.113.10` | Deployment host; do not commit it to the repository. |
| `DSH_EXPERIENCE_SSH_USER` | yes | `deploy` | Dedicated deployment account. |
| `DSH_EXPERIENCE_SSH_PORT` | no | `22` | SSH port. |
| `DSH_EXPERIENCE_DSH_SERVICE` | no | `dsh-web.service` | Existing DSH Web unit. |
| `DSH_EXPERIENCE_DSH_HOME` | no | empty | Set only when service discovery cannot infer the DSH home. |
| `DSH_EXPERIENCE_DSH_EXECUTABLE` | no | empty | Set only when service discovery cannot infer the DSH executable. |
| `DSH_EXPERIENCE_PROFILE` | no | `web` | DSH profile name. |
| `DSH_EXPERIENCE_MODE` | no | `https` | `https` or `http`. |
| `DSH_EXPERIENCE_BEHIND_TLS_PROXY` | no | `false` | `true` only with `http` and a loopback listener behind an operator TLS proxy. |
| `DSH_EXPERIENCE_SERVER_NAME` | HTTPS | empty | DNS name or literal IP covered by automatic or manual TLS. |
| `DSH_EXPERIENCE_TLS` | no | `automatic` | `automatic` or `manual` for HTTPS. |
| `DSH_EXPERIENCE_CERTIFICATE` | manual TLS | empty | Existing absolute certificate path on the host. |
| `DSH_EXPERIENCE_CERTIFICATE_KEY` | manual TLS | empty | Existing absolute private-key path on the host. |
| `DSH_EXPERIENCE_LISTEN_ADDRESS` | no | `0.0.0.0` for HTTPS | Literal bind address. Plain HTTP must be private/loopback unless authorized. |
| `DSH_EXPERIENCE_HTTP_PORT` | no | `80` | HTTP or redirect port. |
| `DSH_EXPERIENCE_HTTPS_PORT` | no | `443` | HTTPS port. |
| `DSH_EXPERIENCE_UPSTREAM` | no | `127.0.0.1:3080` | Loopback Harness listener. |
| `DSH_EXPERIENCE_ADMIN_USERNAME` | no | `operator` | Initial administrator name. |

Configure these as environment secrets, not repository files:

- `DSH_EXPERIENCE_SSH_PRIVATE_KEY`: a dedicated Ed25519 key for the deployment account. Do not reuse a personal key or enable agent forwarding.
- `DSH_EXPERIENCE_SSH_KNOWN_HOSTS`: the reviewed host-key line for the configured host and port. Generate it out of band, verify the fingerprint through an independent channel, and store the resulting line; the workflow intentionally does not use TOFU `ssh-keyscan`.
- `DSH_EXPERIENCE_ADMIN_PASSWORD`: the first-install password. It is transferred over the pinned SSH connection only when `/etc/dsh-auth/install-state.json` is absent, written to a temporary root-only file, read by `setup`, and removed. It is not passed as a command argument.

The SSH account must be able to run the required installer operations with `sudo -n` (or be root). Grant the narrowest host policy practical and keep the host's DSH service upstream on loopback. The managed Caddy remains the only supported authentication edge.

## Operating the workflow

Dispatch **Deploy experience environment** and select the ref to package. The first run performs non-interactive `setup`; later runs perform transactional `upgrade`, preserving the administrator credentials and sessions. A failed upgrade is rolled back by the installer. The job's concurrency lock prevents two deployments from changing the same host at once.

For routine deployments, open **Actions → Deploy experience environment → Run workflow**, keep the workflow ref as `main`, and enter a reviewed branch, tag, or commit already reachable from `main` in the `ref` input. The workflow file and its configuration must already be merged to `main`; the `ref` input only selects the reviewed source that the trusted workflow packages. The equivalent GitHub CLI commands are:

```sh
gh workflow run experience-deploy.yml --ref main -f ref=main
gh run watch --exit-status
```

When asking an agent to deploy, provide a reviewed source ref (for example, a merged branch/tag or commit SHA) and say that it is an experience deployment. The agent should dispatch this workflow, wait for the run to finish, and report the run URL plus the remote health check; it should not publish a release or run an ad-hoc installer command on the host.

For a public HTTPS experience host, configure a DNS name or publicly routable IP with automatic TLS, or install a certificate and use manual TLS. Automatic TLS for a public IP uses the short-lived ACME profile and therefore requires continuous renewal; private IPs are rejected. Plain HTTP is accepted only on a private/loopback address; use `behind-tls-proxy=true` only when an operator-owned TLS proxy reaches the managed Caddy on loopback. Do not move `forward_auth` into that outer proxy.

This workflow is deliberately separate from `release.yml`: it does not publish npm, create a Git tag, or create a GitHub Release. Stable releases continue to use the verified tag tarball and release gates; the experience workflow is for selected development commits and disposable operator-facing validation.

## 首次配置与使用（简体中文）

`.github/workflows/experience-deploy.yml` 是手动触发的体验环境部署，不会发布 npm 或创建 GitHub Release。它只会打包已经合入 `main` 的经过审查的 ref，并临时生成 `X.Y.(Z+1)-experience.<run-id>.<attempt>` 版本；这是因为受管 `upgrade` 要求目标版本严格高于已安装版本。该版本只存在于体验服务器；在加载部署密钥前，工作流会拒绝未合入 `main` 的提交。

创建名为 `dsh-experience` 的 GitHub Environment，只允许从 `main` 部署，并为每次部署设置审批规则。工作流也必须从 `main` 触发；`ref` 参数只能选择已经合入 `main` 的经过审查的源码，工作流会在加载部署密钥前验证这一点。将服务器地址、SSH 用户、DSH systemd 单元、网络/TLS 参数设置为 Environment Variables；将独立的 Ed25519 私钥、已人工核验的 `known_hosts` 行和首次安装密码设置为 Environment Secrets。不要把私钥、密码或主机密钥提交到仓库，也不要让工作流通过 `ssh-keyscan` 做首次信任。

首次运行会执行非交互 `setup`，后续运行执行事务性 `upgrade`，保留管理员凭据和会话；失败升级由安装器回滚。上传的不含密钥的 tarball 会保存在 `/var/lib/dsh-auth-experience/artifacts/`，该目录需要让 DSH 服务用户可遍历；不要删除所有权记录引用的文件，否则离线回滚无法恢复旧 bundle。

### 日常发布

进入 GitHub 仓库的 **Actions → Deploy experience environment → Run workflow**：

1. Workflow ref 保持为 `main`。
2. 在 `ref` 中填写已经合入 `main` 的经过审查的分支、tag 或 commit SHA。
3. 通过 `dsh-experience` 的部署审批。
4. 等待工作流完成，并确认日志中的远端 `doctor` 和 HTTPS 健康检查成功。

也可以使用 GitHub CLI：

```sh
gh workflow run experience-deploy.yml --ref main -f ref=main
gh run watch --exit-status
```

工作流文件和 Environment 配置必须先合入 `main`；`ref` 只能选择已经合入 `main` 的经过审查的源码。以后让 Agent 部署时，只需说明“将已合入的 `<分支或 commit>` 部署到体验环境”，Agent 应触发这个工作流并等待结果，返回运行链接和健康检查结果；不要改用正式 Release 流程，也不要临时 SSH 到服务器执行安装命令。

体验环境仍必须遵守产品边界：Harness 只监听回环地址，受管 Caddy 是唯一鉴权边缘。公网 HTTPS 可使用 DNS 名称或可公网路由的 IP 配自动 TLS（公网 IP 使用短期 ACME 证书并要求持续续期），也可配置服务器已有证书做手动 TLS；私网 IP 会被拒绝。明文 HTTP 只能绑定私网/回环地址；`behind-tls-proxy=true` 仅适用于外层 TLS 代理访问回环上的受管 Caddy，不能把 `forward_auth` 移到外层代理。
