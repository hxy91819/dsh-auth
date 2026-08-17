# dsh-auth

[![npm version](https://img.shields.io/npm/v/dsh-auth.svg)](https://www.npmjs.com/package/dsh-auth)
[![CI](https://github.com/hxy91819/dsh-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/hxy91819/dsh-auth/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-auth.svg)](LICENSE)

Add a secure single-account login to the DeepSeek Harness Web app. `dsh-auth` keeps Harness on loopback and installs an Nginx `auth_request` edge for pages, APIs, downloads, SSE, and WebSockets.

## Quick start

### Interactive setup

Start with an existing DSH Web systemd service whose upstream listens only on loopback, then run:

```sh
sudo npx dsh-auth@0.1.11 setup
```

The interactive installer asks for the exact DSH service, account name, HTTPS hostname, and certificate paths; shows a secret-free plan; reads and confirms the password without echo; and changes the system only after you type the exact confirmation. It installs the pinned bundle into the selected DSH profile, writes permission-restricted file-backed credentials and a systemd `EnvironmentFile` drop-in, renders the Nginx include, runs `nginx -t`, restarts only the named DSH service, then reloads Nginx. It never stores the plaintext password.

If Nginx is missing, the installer detects the operating system first. On the verified Ubuntu 24.04 baseline it can show and, after a separate `install-nginx` confirmation, run fixed `apt-get` argv. It uses only configured system repositories. Other systems fail closed with a copyable remediation; no `curl | sh` path exists.

Normal deployment requires Nginx 1.24 or newer with `ngx_http_auth_request_module`, systemd, Node.js 24.7 or newer, DSH Web 0.1.0-rc.6, and an existing TLS certificate and key. The installer cannot and does not guess a domain or certificate.

```text
$ sudo npx dsh-auth@0.1.11 setup
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
sudo npx dsh-auth@0.1.11 plan
```

### CLI setup (non-interactive)

Non-interactive mode requires stable flags and an explicit Nginx policy. Mount the plaintext password as a temporary `0600` secret file supplied by the platform; `dsh-auth` reads it once to create an Argon2id hash and does not copy the plaintext.

```sh
sudo npx dsh-auth@0.1.11 setup \
  --non-interactive \
  --json \
  --nginx install \
  --authorize-nginx-install \
  --dsh-service dsh-web.service \
  --dsh-home /var/lib/dsh \
  --dsh-bin /usr/local/bin/dsh \
  --profile web \
  --package dsh-auth@0.1.11 \
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

Use `--nginx require` when the image or provisioning layer already installs Nginx; missing or incompatible Nginx then returns exit code 3 and a JSON diagnostic. `--nginx install` never installs anything without `--authorize-nginx-install`. `--nginx skip` is accepted only with `--output-dir`, where no service or system Nginx action occurs.

Passwords are accepted only through hidden interactive input, `--password-stdin`, or `--password-file`. There is no inline password flag. Command output, JSON, plans, subprocess argv, and installer errors never contain password or session-secret values.

## Reset the password

For an installation created by `setup`, run the interactive reset:

```sh
sudo npx dsh-auth@0.1.11 reset-password
```

After exact confirmation, the command reads and confirms the new password without echo. It atomically replaces the managed Argon2id hash, rotates the session secret, revokes all existing sessions, and restarts the recorded DSH service only when it is active. A failed restart restores both previous credential files.

Automation must provide the password through stdin or a temporary `0600` file and explicitly authorize the operation:

```sh
sudo npx dsh-auth@0.1.11 reset-password \
  --non-interactive \
  --json \
  --authorize-password-reset \
  --password-file /run/secrets/dsh-auth-new-password
```

The command never accepts a password value in argv and does not print the password, hash, or session secret.

## Plain HTTP for an isolated trusted network

Plain HTTP remains authenticated but exposes credentials and sessions to network interception. It is accepted only with an explicit `--mode http` and a literal loopback, RFC1918, or ULA listen address:

```sh
sudo npx dsh-auth@0.1.11 setup \
  --nginx require \
  --mode http \
  --listen-address 10.0.0.20 \
  --http-port 8080
```

Do not use this mode on an untrusted network. HTTPS is the production default.

## Doctor and uninstall

`doctor` checks the ownership record, file permissions, the exact DSH service, root-executable safety, Nginx version and module support, `nginx -t`, and service state:

```sh
sudo npx dsh-auth@0.1.11 doctor
sudo npx dsh-auth@0.1.11 doctor --json
```

`uninstall --dry-run` lists only files and profile changes proven by the ownership record. Interactive uninstall requires typing `uninstall`; automation requires the exact `--authorize-uninstall` flag. Nginx is always retained as a shared system package, even when setup originally installed it.

```sh
sudo npx dsh-auth@0.1.11 uninstall --dry-run
sudo npx dsh-auth@0.1.11 uninstall
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

```sh
corepack pnpm pack --pack-destination packed
dsh plugin --profile web add --offline --config.auto-install-peers=false /artifacts/dsh-auth-0.1.11.tgz
```

Generate deterministic runtime files without invoking systemd, a package manager, or a host Nginx binary:

```sh
dsh-auth setup \
  --non-interactive \
  --nginx skip \
  --output-dir /image/dsh-auth \
  --package /artifacts/dsh-auth-0.1.11.tgz \
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
```

Contributors should read [`AGENTS.md`](AGENTS.md). Installer architecture and maintenance checks are in [`docs/installer.md`](docs/installer.md).
