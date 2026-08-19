# dsh-auth

[English](README.md) | 简体中文

[![npm version](https://img.shields.io/npm/v/dsh-auth.svg)](https://www.npmjs.com/package/dsh-auth)
[![CI](https://github.com/hxy91819/dsh-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/hxy91819/dsh-auth/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-auth.svg)](LICENSE)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的非官方社区插件。为 DeepSeek Harness Web 应用增加安全的管理员登录。`dsh-auth` 让 Harness 只监听回环地址，并安装由本项目维护的 Caddy `forward_auth` 边缘，覆盖页面、API、下载、SSE 和 WebSocket。

0.2.0 相对旧版 v1 部署是破坏性升级。旧安装器参数、由 Nginx 管理的安装，以及旧会话都不会迁移。请先卸载旧安装，再重新执行 `setup`。

## 快速开始

### 交互式安装

安装已发布的 CLI，然后从一个现有的 DSH Web systemd 服务开始；该服务的上游必须只监听回环地址：

```sh
sudo npm install -g dsh-auth
sudo dsh-auth setup
```

`npm install -g dsh-auth` 安装当前稳定版 CLI，安装器会把同一版本钉死到所选 DSH profile。若需按供应链策略做受控生产发布，请安装已批准的精确版本：

```sh
sudo npm install -g dsh-auth@0.2.2
```

交互式安装器会询问精确的 DSH 服务、管理员初始化方式、HTTPS 主机名和 TLS 模式；展示一份不含密钥的计划；只有在你输入精确确认词后才会改动系统。它会把钉死的包安装进所选 DSH profile，复制同包内经过校验和验证的 Caddy 二进制，写入权限受限的认证状态，并启用独立的 `dsh-auth-caddy.service`。它从不存储明文密码，安装时也从不下载 Caddy。

常规部署需要 Linux x64 或 ARM64、systemd、Node.js 24.7 或更新版本，以及 DSH Web 0.1.0-rc.7。自动 TLS 是 HTTPS 默认值。手动 TLS 需要已有的证书和私钥。

```text
$ sudo dsh-auth setup
Existing DSH Web systemd unit: dsh-web.service
Administrator initialization (password/login-token): password
Login tokens (enabled/disabled) [disabled]: enabled
Administrator username: operator
Edge mode (https/http) [https]:
TLS (automatic/manual) [automatic]:
Public HTTPS hostname: harness.example.com
...
Type install to apply this exact plan: install
Password:
Confirm password:
dsh-auth setup completed successfully.
```

重复执行同一命令是幂等的。若已有受管安装且非密钥配置完全相同，会报告未发生变化；配置不同，或文件没有所有权记录时，会拒绝覆盖而不是改写。

在正式安装前可用 `plan` 查看同一份类型化计划，不会读取密码，也不会改动文件系统：

```sh
sudo dsh-auth plan
```

### 命令行安装（非交互）

非交互模式需要稳定的参数，以及明确的管理员初始化方式。密码初始化时，请把明文密码挂载为平台提供的临时 `0600` 密钥文件；`dsh-auth` 只读取一次以生成 Argon2id 哈希，不会复制明文。

这些命令名、参数名、`--name value` 或 `--name=value` 语法、JSON schema 第 2 版，以及退出码，构成公开自动化契约。全局参数可以放在命令之前。允许新增参数和诊断码。重命名、删除或改变已有参数、JSON 字段或退出码的含义属于破坏性变更。

打印冻结的用法文本：

```sh
dsh-auth --help
dsh-auth --version
```

`-h` 是 `--help` 的别名。`dsh-auth setup --help` 打印相同的用法文本。下面的示例是一次完整的 HTTPS 系统安装：密码初始化，并使用自动 TLS。

只有在 stdin 和 stdout 都是 TTY，且未设置 `--non-interactive` 时才会出现提示。`--json` 只影响输出格式，不会关闭提示。

```sh
sudo dsh-auth setup \
  --non-interactive \
  --json \
  --dsh-service dsh-web.service \
  --dsh-home /var/lib/dsh \
  --dsh-executable /usr/local/bin/dsh \
  --profile web \
  --admin-bootstrap password \
  --admin-username operator \
  --login-token enabled \
  --password-file /run/secrets/dsh-auth-password \
  --mode https \
  --tls automatic \
  --upstream 127.0.0.1:3080 \
  --listen-address 0.0.0.0 \
  --server-name harness.example.com
```

令牌初始化不需要密码和用户名。第一位获授权用户在浏览器中设置它们，也可以选择稍后设置：

```sh
sudo dsh-auth setup \
  --non-interactive \
  --json \
  --dsh-service dsh-web.service \
  --admin-bootstrap login-token \
  --login-token enabled \
  --mode https \
  --tls automatic \
  --server-name harness.example.com
```

| 参数 | 是否必需 | 默认值 | 说明 |
|---|---|---|---|
| `--help`、`-h` | 否 | | 打印用法并退出。 |
| `--version` | 否 | | 打印 CLI 版本并退出。 |
| `--non-interactive` | 在 TTY 上 | | 关闭提示。 |
| `--json` | 否 | | 输出一份 JSON 文档。不会关闭提示。 |
| `--mode` | 否 | `https` | `https` 或 `http`。 |
| `--admin-bootstrap` | 非提示模式时 | | `password` 或 `login-token`。 |
| `--admin-username` | 密码安装时 | | 初始管理员登录名。 |
| `--login-token` | 非提示模式时 | | `enabled` 或 `disabled`。令牌初始化必须为 `enabled`。 |
| `--login-token-error-message-zh` | 否 | 内置中文文案 | 可选的 1–500 字符中文令牌失败页文本。需要 `--login-token enabled`。 |
| `--login-token-error-message-en` | 否 | 内置英文文案 | 可选的 1–500 字符英文令牌失败页文本。需要 `--login-token enabled`。 |
| `--listen-address` | HTTP | HTTPS 为 `0.0.0.0` | 字面量 IP 绑定地址。HTTP 仍必须显式指定私网或回环地址。 |
| `--dsh-service` | 系统安装 | | 精确的现有 DSH Web systemd 单元。仅在使用 `--output-dir` 时可省略。 |
| `--password-file` 或 `--password-stdin` | 就绪密码的 `setup` | | 密码来源。`plan` 和令牌初始化不使用。未变化的重复执行会跳过。 |
| `--server-name` | `--mode https` | | 公开 HTTPS 主机名。 |
| `--tls` | HTTPS | `automatic` | `automatic` 或 `manual`。 |
| `--certificate` | `--tls manual` | | TLS 证书的绝对路径。 |
| `--certificate-key` | `--tls manual` | | TLS 私钥的绝对路径。 |
| `--dry-run` | 否 | | 在 `setup` 上等价于 `plan`。在 `uninstall` 上列出将删除的自有文件，但不改动主机。 |
| `--dsh-home` | 否 | 自动发现 | 单元无法推断时的 Harness 主目录。 |
| `--dsh-executable` | 否 | 自动发现 | 单元无法推断时的 DSH 可执行文件。必须是文件，不能是目录。 |
| `--profile` | 否 | `web` | DSH profile 名称。 |
| `--upstream` | 否 | `127.0.0.1:3080` | 回环 DSH 监听地址（`127.0.0.1` 或 `[::1]`）。 |
| `--package` | 否 | `dsh-auth@<CLI version>` | 钉死的 registry 规格或绝对路径 `.tgz`。 |
| `--http-port` | 否 | `80`（HTTP 为 `8080`） | HTTP 或 HTTPS 重定向端口。 |
| `--https-port` | 否 | `443` | HTTPS 监听端口。 |
| `--output-dir` | 否 | | 离线或容器渲染目录。跳过 systemd。 |

已删除且无别名：`--nginx`、`--authorize-nginx-install`、`--user-id`、`--username`、`--roles` 和 `--dsh-bin`。

其他命令接受更小的冻结参数集：

| 命令 | 非提示模式时的必需项 | 可选项 |
|---|---|---|
| `plan` | 与 setup 相同的参数，但不需要密码来源 | `--json`、`--non-interactive` |
| `doctor` | | `--json` |
| `reset-password` | `--password-file` 或 `--password-stdin`；`--authorize-password-reset` | `--json`、`--non-interactive` |
| `uninstall` | `--authorize-uninstall` | `--json`、`--non-interactive`、`--dry-run` |
| `issue-login-token` | 非提示模式时需要 `--authorize-login-token-issue` | `--ttl-seconds`、与 `--public-origin` 一起使用的 `--auth-state-file`、`--json` |
| `hash` | | `--password-stdin` |
| `secret` | | |

密码只能通过隐藏的交互输入、`--password-stdin` 或 `--password-file` 提供。没有内联密码参数。命令输出、JSON、计划、子进程 argv 和安装器错误从不包含密码或会话密钥。`issue-login-token` 是唯一允许在成功的 stdout 或 JSON 中包含持有者登录令牌的命令。

## 签发一次性登录链接

安装时若启用了登录令牌，云控制面或运维人员可以签发一次性 URL。原始令牌只出现在成功的人类可读 URL 行，或 JSON 成功文档中：

```sh
sudo dsh-auth issue-login-token --non-interactive --authorize-login-token-issue
```

URL 使用 fragment（`/auth/token#token=…`）。打开后会建立与密码登录相同的 72 小时滚动会话。若尚未设置管理员密码，浏览器会先提供设置页；选择稍后只会跳过那一次登录。

容器和镜像布局需要显式传入路径，而不是读取 systemd 所有权记录：

```sh
dsh-auth issue-login-token \
  --non-interactive \
  --authorize-login-token-issue \
  --json \
  --auth-state-file /export/dsh-auth/state/auth-state.json \
  --public-origin https://harness.example.com
```

安装时可以替换内置失败页文案。中文和英文可分别配置；省略某种语言则保留其内置文案。每个值是 1–500 个 Unicode 字符的纯文本。控制字符会被拒绝，HTML 按文本显示而不是按标记渲染。当 `--login-token` 为 `disabled` 时，安装器会拒绝这些参数。

格式错误、已过期、已使用和未知令牌都会返回同一份带该文案的 HTTP 401 页面。页面不会区分具体是哪一种情况。

```sh
sudo dsh-auth setup \
  --login-token enabled \
  --login-token-error-message-zh '登录链接不可用，请向管理员重新申请。' \
  --login-token-error-message-en 'This sign-in link is unavailable. Request a new one from your administrator.'
```

## 重置密码

已登录管理员可以打开 **设置 → 通用 → 重置密码**，输入当前密码并设置新密码。这会更新存储的哈希，并让其他浏览器会话退出；不会轮换会话密钥。

如果当前密码不可用，对由 `setup` 创建的安装拥有 root 权限的运维人员可以运行交互式重置：

```sh
sudo dsh-auth reset-password
```

在精确确认后，命令会无回显地读取并确认新密码。它会原子替换受管 Argon2id 哈希、轮换会话密钥、吊销全部现有会话，并仅在已记录的 DSH 服务处于活动状态时重启它。重启失败会同时恢复两份先前的凭据文件。

自动化必须通过 stdin 或临时 `0600` 文件提供密码，并显式授权该操作：

```sh
sudo dsh-auth reset-password \
  --non-interactive \
  --json \
  --authorize-password-reset \
  --password-file /run/secrets/dsh-auth-new-password
```

该命令从不在 argv 中接受密码值，也不会打印密码、哈希或会话密钥。

## 隔离可信网络上的明文 HTTP

明文 HTTP 仍然需要认证，但会把凭据和会话暴露给网络窃听。只有显式指定 `--mode http`，并给出字面量回环、RFC1918 或 ULA 监听地址时才会接受：

```sh
sudo dsh-auth setup \
  --admin-bootstrap password \
  --admin-username operator \
  --login-token disabled \
  --mode http \
  --listen-address 10.0.0.20 \
  --http-port 8080
```

不要在不受信任的网络上使用此模式。HTTPS 是生产默认值。

## 诊断、卸载与 v1 重装

`doctor` 会检查所有权记录、文件权限、精确的 DSH 服务、root 可执行安全性、Caddy 版本与校验和、`caddy validate`，以及服务状态：

```sh
sudo dsh-auth doctor
sudo dsh-auth doctor --json
```

`uninstall --dry-run` 只列出所有权记录能证明的文件和 profile 变更。交互式卸载需要输入 `uninstall`；自动化需要精确的 `--authorize-uninstall` 参数。会移除独立的 Caddy 单元；从不触碰用户自行安装的 Caddy 或 Nginx。

```sh
sudo dsh-auth uninstall --dry-run
sudo dsh-auth uninstall
```

schema v1 所有权记录、旧 Nginx 参数和旧插件身份字段会被拒绝，并给出重装诊断。没有自动迁移。卸载并重新 setup 后，旧会话会失效。

## 退出码

| 码 | 含义 |
|---:|---|
| `0` | 成功、健康，或未发生变化 |
| `2` | CLI 输入无效或不完整 |
| `3` | 缺少或不支持的前置条件 |
| `4` | 所有权或现有配置冲突 |
| `5` | 权限不足或不安全 |
| `6` | 执行或回滚失败 |
| `7` | 改动前的交互式取消 |
| `8` | doctor 发现安装不健康 |

JSON 输出使用 schema 第 2 版，包含命令、状态、退出码、已脱敏的操作，以及结构化诊断。

## Docker 与离线镜像

构建并钉死精确的 npm tarball，然后在没有 registry 访问的情况下安装进 DSH profile：

将 `X.Y.Z` 替换为打包产物文件名中的版本。

```sh
corepack pnpm pack --pack-destination packed
dsh plugin --profile web add --offline --config.auto-install-peers=false /artifacts/dsh-auth-X.Y.Z.tgz
```

生成确定性运行时文件，不调用 systemd、包管理器或主机上的 Caddy 二进制：

```sh
dsh-auth setup \
  --non-interactive \
  --output-dir /image/dsh-auth \
  --package /artifacts/dsh-auth-X.Y.Z.tgz \
  --admin-bootstrap password \
  --admin-username operator \
  --login-token enabled \
  --password-file /run/secrets/dsh-auth-password \
  --server-name harness.example.com \
  --tls manual \
  --certificate /run/tls/fullchain.pem \
  --certificate-key /run/tls/privkey.pem
```

输出目录包含 `dsh-auth.env`、基于文件的凭据、认证状态、登录令牌目录和 Caddyfile。将它们复制或挂载到固定镜像路径，并显式接入环境文件和 Caddy 配置。同一份 tarball 已包含 linux-x64 和 linux-arm64 的 Caddy 二进制；setup 会在校验和验证后复制当前架构，从不下载二进制。[`deploy/docker/Dockerfile.install`](deploy/docker/Dockerfile.install) 展示了离线 profile 层。

## 安全行为与边界

- 生产 Cookie 为 `HttpOnly`、`Secure`、`SameSite=Lax`、`Path=/`，并带 `__Host-` 前缀。明文 HTTP 使用显式兼容 Cookie 模式。
- Argon2id 哈希和随机会话密钥分别存放在权限受限的文件中。持久不透明会话使用 `0600` 的认证状态文档。
- 登录、退出、令牌兑换和首次管理员设置会在受信代理解析后强制 CSRF 以及精确的 Origin/Referer 检查。认证响应为 `no-store`。
- 第 2 版每个受管安装只支持一个管理员身份（`admin`）。密码初始化和令牌初始化是明确选项。注册、自助账户恢复、MFA、数据库、多账户策略和多租户不在本版本范围内。
- Caddy 是唯一的公开监听器。标准反向代理无法立即吊销已经打开的 WebSocket。需要立即终止流的部署必须使用连接感知边缘。

安全报告请遵循 [`SECURITY.md`](SECURITY.md)。

## 开发

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm run check
corepack pnpm run check:caddy
corepack pnpm run test:e2e
corepack pnpm pack --pack-destination packed
node scripts/installer-e2e.mjs packed/dsh-auth-X.Y.Z.tgz
```

将 `X.Y.Z` 替换为 `package.json` 中的版本。

`test:e2e` 会打包当前检出、安装进一次性 DSH profile，并驱动真实 TLS Caddy 边缘加无头浏览器。它验证未认证拒绝、登录令牌签发与兑换、首次管理员设置、密码登录、受保护的 SPA/API/下载/WebSocket 路径、会话续期与重启持久化，以及侧栏退出登录的吊销。需要 OpenSSL、`ss` 和 Chrome 或 Chromium；浏览器不在标准 Linux 路径时设置 `DSH_E2E_CHROME_BIN`。未设置 `DSH_E2E_CADDY_BIN` 时，测试会准备一份仅用于隔离、经过校验和验证的官方 Caddy `v2.11.4` 二进制。

贡献者应阅读 [`AGENTS.md`](AGENTS.md)。安装器架构与维护检查见 [`docs/installer.md`](docs/installer.md)。

稳定的 npm 和 GitHub 发布由 [Release 工作流](.github/workflows/release.yml) 调度；维护者应先更新 [changelog](CHANGELOG.md) 并遵循 [`docs/releasing.md`](docs/releasing.md)。
