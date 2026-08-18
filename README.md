# dsh-auth

[![npm version](https://img.shields.io/npm/v/dsh-auth.svg)](https://www.npmjs.com/package/dsh-auth)
[![CI](https://github.com/hxy91819/dsh-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/hxy91819/dsh-auth/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-auth.svg)](LICENSE)

Add a secure single-account login to the DeepSeek Harness Web app. `dsh-auth` keeps Harness on loopback and installs an Nginx `auth_request` edge for pages, APIs, downloads, SSE, and WebSockets.

## Quick start

### Interactive setup

Install the published CLI, then start from an existing DSH Web systemd service whose upstream listens only on loopback:

```sh
sudo npm install -g dsh-auth
sudo dsh-auth setup
```

`npm install -g dsh-auth` installs the current stable CLI, and the installer pins that same version in the selected DSH profile. For controlled production rollout, install the exact version approved by your supply-chain policy:

```sh
sudo npm install -g dsh-auth@X.Y.Z
```

The interactive installer asks for the exact DSH service, account name, HTTPS hostname, and certificate paths; shows a secret-free plan; reads and confirms the password without echo; and changes the system only after you type the exact confirmation. It installs the pinned bundle into the selected DSH profile, writes permission-restricted file-backed credentials and a systemd `EnvironmentFile` drop-in, renders the Nginx include, runs `nginx -t`, restarts only the named DSH service, then reloads Nginx. It never stores the plaintext password.

If Nginx is missing, the installer detects the operating system first. On the verified Ubuntu 24.04 baseline it can show and, after a separate `install-nginx` confirmation, run fixed `apt-get` argv. It uses only configured system repositories. Other systems fail closed with a copyable remediation; no `curl | sh` path exists.

Normal deployment requires Nginx 1.24 or newer with `ngx_http_auth_request_module`, systemd, Node.js 24.7 or newer, DSH Web 0.1.0-rc.6, and an existing TLS certificate and key. The installer cannot and does not guess a domain or certificate.

```text
$ sudo dsh-auth setup
Existing DSH Web systemd unit: dsh-web.service
Stable user id [admin]:
Login username [admin]: operator
Edge mode (https/http) [https]:
HTTPS listen address [0.0.0.0]:
Public HTTPS hostname: harness.example.com
TLS certificate absolute path: /etc/letsencrypt/live/harness.example.com/fullchain.pem
TLS certificate key absolute path: /etc/letsencrypt/live/harness.example.com/privkey.pem
...
Type install to apply this exact plan: install
Password:
Confirm password:
dsh-auth setup completed successfully.
```

Rerunning the same command is idempotent. An existing managed installation with identical non-secret settings is reported unchanged; different settings or files without an ownership record are rejected instead of overwritten.

Use `plan` before setup to inspect the same typed plan without reading a password or changing the filesystem:

```sh
sudo dsh-auth plan
```

### CLI setup (non-interactive)

Non-interactive mode requires stable flags and an explicit Nginx policy. Mount the plaintext password as a temporary `0600` secret file supplied by the platform; `dsh-auth` reads it once to create an Argon2id hash and does not copy the plaintext.

Print the command list, setup options, and which non-interactive flags are required:

```sh
dsh-auth --help
```

`dsh-auth setup --help` prints the same text. The example below is a complete HTTPS system install. Several flags in it are optional pins; the table after it marks what automation must supply.

```sh
sudo dsh-auth setup \
  --non-interactive \
  --json \
  --nginx install \
  --authorize-nginx-install \
  --dsh-service dsh-web.service \
  --dsh-home /var/lib/dsh \
  --dsh-bin /usr/local/bin/dsh \
  --profile web \
  --user-id primary-admin \
  --username operator \
  --roles admin \
  --password-file /run/secrets/dsh-auth-password \
  --mode https \
  --upstream 127.0.0.1:3080 \
  --listen-address 0.0.0.0 \
  --server-name harness.example.com \
  --certificate /etc/letsencrypt/live/harness.example.com/fullchain.pem \
  --certificate-key /etc/letsencrypt/live/harness.example.com/privkey.pem
```

| Flag | Required | Default | Description |
|---|---|---|---|
| `--help` | no | | Print usage and exit. Accepted as `dsh-auth --help` or `dsh-auth setup --help`. |
| `--non-interactive` | yes | | Disable prompts. Missing required flags fail with exit code 2. |
| `--nginx` | yes | | `require`, `install`, or `skip`. |
| `--mode` | yes | | `https` or `http`. |
| `--user-id` | yes | | Stable account id written into configuration. |
| `--username` | yes | | Login name. |
| `--listen-address` | yes | | Edge bind address. |
| `--dsh-service` | system setup | | Exact existing DSH Web systemd unit. Omit only with `--output-dir`. |
| `--password-file` or `--password-stdin` | first-time `setup` | | Password source. Not used by `plan`. Unchanged reruns skip it. |
| `--server-name` | `--mode https` | | Public HTTPS hostname. |
| `--certificate` | `--mode https` | | Absolute TLS certificate path. |
| `--certificate-key` | `--mode https` | | Absolute TLS private-key path. |
| `--authorize-nginx-install` | `--nginx install` | | Authorize the supported OS package commands. |
| `--json` | no | | Emit one machine-readable JSON document. |
| `--dry-run` | no | | Alias for `plan`. |
| `--dsh-home` | no | discovered | Harness home when the unit does not infer it. |
| `--dsh-bin` | no | discovered | DSH executable when the unit does not infer it. |
| `--profile` | no | `web` | DSH profile name. |
| `--roles` | no | `admin` | Comma-separated role ids. |
| `--upstream` | no | `127.0.0.1:3080` | Loopback DSH listener. |
| `--package` | no | `dsh-auth@<this version>` | Pinned registry spec or absolute `.tgz`. |
| `--http-port` | no | `80` (`8080` for HTTP) | HTTP or HTTPS-redirect port. |
| `--https-port` | no | `443` | HTTPS listen port. |
| `--output-dir` | with `--nginx skip` | | Offline or container render directory. |

Use `--nginx require` when the image or provisioning layer already installs Nginx; missing or incompatible Nginx then returns exit code 3 and a JSON diagnostic. `--nginx install` never installs anything without `--authorize-nginx-install`. `--nginx skip` is accepted only with `--output-dir`, where no service or system Nginx action occurs.

Passwords are accepted only through hidden interactive input, `--password-stdin`, or `--password-file`. There is no inline password flag. Command output, JSON, plans, subprocess argv, and installer errors never contain password or session-secret values.

## Preview

Unauthenticated visitors see a responsive login page styled to match DeepSeek Harness:

<p align="center">
  <img src="https://raw.githubusercontent.com/hxy91819/dsh-auth/main/docs/images/login.png" alt="dsh-auth login page for DeepSeek Harness" width="720">
</p>

After sign-in, users enter the real Harness Web app with its normal sessions, tools, model selection, and workspace navigation. The authentication plugin adds a native sign-out action to the sidebar:

![Authenticated DeepSeek Harness Web app with the dsh-auth sign-out action](https://raw.githubusercontent.com/hxy91819/dsh-auth/main/docs/images/authenticated-harness.png)

## Reset the password

For an installation created by `setup`, run the interactive reset:

```sh
sudo dsh-auth reset-password
```

After exact confirmation, the command reads and confirms the new password without echo. It atomically replaces the managed Argon2id hash, rotates the session secret, revokes all existing sessions, and restarts the recorded DSH service only when it is active. A failed restart restores both previous credential files.

Automation must provide the password through stdin or a temporary `0600` file and explicitly authorize the operation:

```sh
sudo dsh-auth reset-password \
  --non-interactive \
  --json \
  --authorize-password-reset \
  --password-file /run/secrets/dsh-auth-new-password
```

The command never accepts a password value in argv and does not print the password, hash, or session secret.

## Plain HTTP for an isolated trusted network

Plain HTTP remains authenticated but exposes credentials and sessions to network interception. It is accepted only with an explicit `--mode http` and a literal loopback, RFC1918, or ULA listen address:

```sh
sudo dsh-auth setup \
  --nginx require \
  --mode http \
  --listen-address 10.0.0.20 \
  --http-port 8080
```

Do not use this mode on an untrusted network. HTTPS is the production default.

## Doctor and uninstall

`doctor` checks the ownership record, file permissions, the exact DSH service, root-executable safety, Nginx version and module support, `nginx -t`, and service state:

```sh
sudo dsh-auth doctor
sudo dsh-auth doctor --json
```

`uninstall --dry-run` lists only files and profile changes proven by the ownership record. Interactive uninstall requires typing `uninstall`; automation requires the exact `--authorize-uninstall` flag. Nginx is always retained as a shared system package, even when setup originally installed it.

```sh
sudo dsh-auth uninstall --dry-run
sudo dsh-auth uninstall
```

## Exit codes

| Code | Meaning |
|---:|---|
| `0` | success, healthy, or unchanged |
| `2` | invalid or incomplete CLI input |
| `3` | missing or unsupported prerequisite |
| `4` | ownership or existing-configuration conflict |
| `5` | insufficient or unsafe permissions |
| `6` | execution or rollback failure |
| `7` | interactive cancellation before changes |
| `8` | doctor found an unhealthy installation |

JSON output uses schema version 1 and includes the command, status, exit code, redacted actions, and structured diagnostics.

## Docker and offline images

Build and pin the exact npm tarball, then install it into the DSH profile without registry access:

Replace `X.Y.Z` with the version in the packed artifact's filename.

```sh
corepack pnpm pack --pack-destination packed
dsh plugin --profile web add --offline --config.auto-install-peers=false /artifacts/dsh-auth-X.Y.Z.tgz
```

Generate deterministic runtime files without invoking systemd, a package manager, or a host Nginx binary:

```sh
dsh-auth setup \
  --non-interactive \
  --nginx skip \
  --output-dir /image/dsh-auth \
  --package /artifacts/dsh-auth-X.Y.Z.tgz \
  --user-id primary-admin \
  --username operator \
  --password-file /run/secrets/dsh-auth-password \
  --mode https \
  --listen-address 0.0.0.0 \
  --server-name harness.example.com \
  --certificate /run/tls/fullchain.pem \
  --certificate-key /run/tls/privkey.pem
```

The output directory contains `dsh-auth.env`, file-backed credentials, a session-state directory, and `dsh-auth.nginx.conf`. Copy or mount them into fixed image paths and explicitly wire the environment file and Nginx include. [`deploy/docker/Dockerfile.install`](deploy/docker/Dockerfile.install) shows the offline profile layer.

## Security behavior and limits

- Production cookies are `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, and `__Host-` prefixed. Plain HTTP uses an explicit compatibility cookie mode.
- Argon2id hashes and random session secrets live in separate permission-restricted files. Persistent opaque sessions use a `0600` store.
- Login and logout enforce CSRF plus exact Origin/Referer checks after trusted-proxy resolution. Authentication responses are `no-store`.
- Version 1 supports one account and one DSH Web service per managed installation. Registration, self-service account recovery, MFA, databases, multi-account policy, and multi-tenancy are outside this release.
- A standard Nginx `auth_request` cannot immediately revoke an already-open WebSocket. Deployments requiring immediate stream termination need a connection-aware edge.

Security reports follow [`SECURITY.md`](SECURITY.md).

## Development

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm run check
corepack pnpm run check:nginx
corepack pnpm run test:e2e
corepack pnpm pack --pack-destination packed
node scripts/installer-e2e.mjs packed/dsh-auth-X.Y.Z.tgz
```

Replace `X.Y.Z` with the version in `package.json`.

`test:e2e` packs the current checkout, installs it into a disposable DSH profile, and drives a real TLS Nginx edge plus a headless browser. It verifies unauthenticated denial, login, the protected SPA/API/download/WebSocket paths, session renewal and restart persistence, and sidebar sign-out revocation. It requires Nginx, OpenSSL, `ss`, and Chrome or Chromium; set `DSH_E2E_CHROME_BIN` when the browser is not installed at a standard Linux path.

Contributors should read [`AGENTS.md`](AGENTS.md). Installer architecture and maintenance checks are in [`docs/installer.md`](docs/installer.md).

Stable npm and GitHub releases are dispatched from the [Release workflow](.github/workflows/release.yml); maintainers should update the [changelog](CHANGELOG.md) and follow [`docs/releasing.md`](docs/releasing.md) first.
