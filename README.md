# dsh-auth

English | [简体中文](README.zh-CN.md)

[![npm version](https://img.shields.io/npm/v/dsh-auth.svg)](https://www.npmjs.com/package/dsh-auth)
[![CI](https://github.com/hxy91819/dsh-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/hxy91819/dsh-auth/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-auth.svg)](LICENSE)

Unofficial community plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Add a secure administrator login to the DeepSeek Harness Web app. `dsh-auth` keeps Harness on loopback and installs a project-owned Caddy `forward_auth` edge for pages, APIs, downloads, SSE, and WebSockets.

Version 0.2.0 is a breaking upgrade from legacy v1 deployments. Previous installer flags, Nginx-managed installations, and old sessions are not migrated. Uninstall the previous installation, then run `setup` again.

## Quick start

### Interactive setup

Install the published CLI, then start from an existing DSH Web systemd service whose upstream listens only on loopback:

```sh
sudo npm install -g dsh-auth
sudo dsh-auth setup
```

`npm install -g dsh-auth` installs the current stable CLI, and the installer pins that same version in the selected DSH profile. For controlled production rollout, install the exact version approved by your supply-chain policy:

```sh
sudo npm install -g dsh-auth@0.2.3
```

### Plugin pre-install is not enabled authentication

`dsh plugin --profile web add dsh-auth` (or a local tarball) only adds the bundle to the Web profile. With both core environment variables absent the bundle stays dormant: Web keeps booting normally, no authentication routes or settings UI appear, and nothing is exposed. A partially supplied configuration still fails loudly instead of booting. Enabling authentication always requires the globally installed CLI and `sudo dsh-auth setup`; the plugin command never creates secrets, installs Caddy, or protects anything.

When setup finds a pre-installed bundle whose package name, version, and build content exactly match the running CLI, it adopts it: no package is reinstalled, and the bundle keeps external ownership. Any other pre-installed build is refused before the host changes. Rollback and uninstall leave an adopted bundle in place; without managed configuration it simply returns to dormancy.

The interactive installer asks for the exact DSH service, administrator initialization method, HTTPS hostname, and TLS mode; shows a secret-free plan; and changes the system only after you type the exact confirmation. It installs the pinned bundle into the selected DSH profile, copies a checksum-verified Caddy binary bundled in the same package, writes permission-restricted authentication state, and enables an independent `dsh-auth-caddy.service`. It never stores a plaintext password and never downloads Caddy at setup time.

Normal deployment requires Linux x64 or ARM64, systemd, Node.js 24.7 or newer, and DSH Web 0.1.0-rc.7. Automatic TLS is the HTTPS default. Manual TLS requires an existing certificate and key. `--server-name` accepts either a DNS name or a public literal IP address.

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

Rerunning the same command is idempotent. An existing managed installation with identical non-secret settings is reported unchanged; different settings or files without an ownership record are rejected instead of overwritten.

Use `plan` before setup to inspect the same typed plan without reading a password or changing the filesystem:

```sh
sudo dsh-auth plan
```

### CLI setup (non-interactive)

Non-interactive mode requires stable flags and an explicit administrator initialization method. For password initialization, mount the plaintext password as a temporary `0600` secret file supplied by the platform; `dsh-auth` reads it once to create an Argon2id hash and does not copy the plaintext.

These command names, flag names, `--name value` or `--name=value` syntax, JSON schema version 2, and exit codes are the public automation contract. Global flags may precede the command. New flags and diagnostic codes may be added. Renaming, removing, or changing the meaning of an existing flag, JSON field, or exit code is a breaking change.

Print the frozen usage text:

```sh
dsh-auth --help
dsh-auth --version
```

`-h` is an alias for `--help`. `dsh-auth setup --help` prints the same usage text. The example below is a complete HTTPS system install with password initialization and automatic TLS.

Prompts run only when stdin and stdout are both TTYs and `--non-interactive` is not set. `--json` is output format only and does not disable prompts.

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

Token initialization omits the password and username. The first authorized user sets them in the browser, or chooses Later:

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

| Flag | Required | Default | Description |
|---|---|---|---|
| `--help`, `-h` | no | | Print usage and exit. |
| `--version` | no | | Print the CLI version and exit. |
| `--non-interactive` | on a TTY | | Disable prompts. |
| `--json` | no | | Emit one JSON document. Does not disable prompts. |
| `--mode` | no | `https` | `https` or `http`. |
| `--behind-tls-proxy` | no | disabled | Keep the managed HTTP edge on loopback, require trusted HTTPS forwarding headers, and issue Secure cookies. |
| `--admin-bootstrap` | when not prompting | | `password` or `login-token`. |
| `--admin-username` | password setup | | Initial administrator login name. |
| `--login-token` | when not prompting | | `enabled` or `disabled`. Token initialization requires `enabled`. |
| `--login-token-error-message-zh` | no | built-in Chinese copy | Optional 1–500 character Chinese token-failure page text. Requires `--login-token enabled`. |
| `--login-token-error-message-en` | no | built-in English copy | Optional 1–500 character English token-failure page text. Requires `--login-token enabled`. |
| `--listen-address` | HTTP | `0.0.0.0` for HTTPS | Literal IP bind address. HTTP still requires an explicit private or loopback address. |
| `--dsh-service` | system setup | | Exact existing DSH Web systemd unit. Omit only with `--output-dir`. |
| `--password-file` or `--password-stdin` | ready password `setup` | | Password source. Not used by `plan` or token initialization. Unchanged reruns skip it. |
| `--server-name` | `--mode https` | | Public HTTPS hostname. |
| `--tls` | HTTPS | `automatic` | `automatic` or `manual`. |
| `--certificate` | `--tls manual` | | Absolute TLS certificate path. |
| `--certificate-key` | `--tls manual` | | Absolute TLS private-key path. |
| `--dry-run` | no | | On `setup`, alias for `plan`. On `uninstall`, list owned removals without changing the host. |
| `--dsh-home` | no | discovered | Harness home when the unit does not infer it. |
| `--dsh-executable` | no | discovered | DSH executable file when the unit does not infer it. Not a directory. |
| `--profile` | no | `web` | DSH profile name. |
| `--upstream` | no | `127.0.0.1:3080` | Loopback DSH listener (`127.0.0.1` or `[::1]`). |
| `--package` | no | `dsh-auth@<CLI version>` | Pinned registry spec or absolute `.tgz`. |
| `--http-port` | no | `80` (`8080` for HTTP) | HTTP or HTTPS-redirect port. |
| `--https-port` | no | `443` | HTTPS listen port. |
| `--output-dir` | no | | Offline or container render directory. Skips systemd. |

### Free certificates for a public IP

When `--server-name` is a publicly routable IPv4 or IPv6 address and `--tls automatic` is selected, the managed Caddy requests a free Let’s Encrypt IP address certificate with the `shortlived` profile and renews it automatically. Let’s Encrypt requires these certificates to be valid for about six days, so the host must keep Caddy’s persistent state and outbound ACME access available. The HTTP challenge port must be reachable from the Internet (normally TCP 80); the certificate authenticates the IP, not a port, so the HTTPS listener may use another port after issuance.

For the public address `9.135.102.192` on the normal HTTPS port:

```sh
sudo dsh-auth setup \
  --non-interactive \
  --dsh-service dsh-web.service \
  --admin-bootstrap login-token \
  --login-token enabled \
  --mode https \
  --tls automatic \
  --server-name 9.135.102.192 \
  --http-port 80 \
  --https-port 443
```

If ACME validation cannot reach the machine, setup does not turn that into a trusted certificate: use a DNS name, restore public access to the challenge port, or provide an existing certificate with `--tls manual`. `tls internal` remains an explicit local/evaluation fallback and is not a publicly trusted certificate.

Removed without aliases: `--nginx`, `--authorize-nginx-install`, `--user-id`, `--username`, `--roles`, and `--dsh-bin`.

Other commands accept a smaller frozen flag set:

| Command | Required when not prompting | Optional |
|---|---|---|
| `plan` | Same setup flags, without a password source | `--json`, `--non-interactive` |
| `doctor` | | `--json` |
| `upgrade` | `--authorize-upgrade` | `--package`, `--json`, `--non-interactive`, `--dry-run` |
| `reset-password` | `--password-file` or `--password-stdin`; `--authorize-password-reset` | `--json`, `--non-interactive` |
| `uninstall` | `--authorize-uninstall` | `--json`, `--non-interactive`, `--dry-run` |
| `issue-login-token` | `--authorize-login-token-issue` when not prompting | `--ttl-seconds`, `--public-origin`, `--auth-state-file` with `--public-origin`, `--json` |
| `hash` | | `--password-stdin` |
| `secret` | | |

Passwords are accepted only through hidden interactive input, `--password-stdin`, or `--password-file`. There is no inline password flag. Command output, JSON, plans, subprocess argv, and installer errors never contain password or session-secret values. `issue-login-token` is the only command whose successful stdout or JSON may contain a bearer login token.

## Issue a one-time login link

When setup enabled login tokens, a cloud control plane or operator can mint a single-use URL. The raw token appears only in the successful human URL line or the JSON success document:

```sh
sudo dsh-auth issue-login-token --non-interactive --authorize-login-token-issue
```

The URL uses a fragment (`/auth/token#token=…`). Opening it establishes the same 72-hour rolling session as a password login. If the administrator password has not been set, the browser first offers a setup page; Later skips only that login.

Container and image layouts pass explicit paths instead of reading the systemd ownership record:

```sh
dsh-auth issue-login-token \
  --non-interactive \
  --authorize-login-token-issue \
  --json \
  --auth-state-file /export/dsh-auth/state/auth-state.json \
  --public-origin https://harness.example.com
```

A system installation created with `--behind-tls-proxy` also takes the current public HTTPS origin at issue time. The value is not stored by setup, so changing an outer proxy address or port does not require reinstalling dsh-auth:

```sh
sudo dsh-auth issue-login-token \
  --non-interactive \
  --authorize-login-token-issue \
  --public-origin https://203.0.113.10:49152
```

Setup can replace the built-in failure page text. Configure Chinese and English independently; an omitted language keeps its built-in copy. Each value is 1–500 Unicode characters of plain text. Control characters are rejected, and HTML is shown as text rather than markup. The installer refuses these flags when `--login-token` is `disabled`.

Malformed, expired, already-used, and unknown tokens all return the same HTTP 401 page with that text. The page does not identify which of those cases occurred. A token POST that fails the Origin or CSRF check returns a different HTTP 403 page: it asks the user to reopen the latest console link or check the public access address, does not use the 401 text, and does not consume the token.

```sh
sudo dsh-auth setup \
  --login-token enabled \
  --login-token-error-message-zh '登录链接不可用，请向管理员重新申请。' \
  --login-token-error-message-en 'This sign-in link is unavailable. Request a new one from your administrator.'
```

## External identity providers

`dsh-auth` exposes a provider-neutral authorization-code interface. The built-in
`ioa` provider adapts Tencent IOA/Taihu's signed AccessToken exchange while the
session, CSRF, state, and authorization policy remain provider-independent.

Enable it through the Cordis bundle configuration (the provider is disabled by
default):

```yaml
externalIdentity:
  enabled: true
  paasId: ${TAIHU_PAAS_ID}
  tokenFile: /run/secrets/taihu-token
  baseUrl: https://api.woa.com
  callbackUrl: https://lightpilot.woa.com/auth/callback
  allowedUsers: [masonxhuang, yuehuali]
  allowedDepartmentIds: []
  allowedDepartmentPrefixes: []
```

Users start the flow at `/auth/login/ioa`. The callback validates a
short-lived state value, exchanges the one-time code server-side, applies the
configured user/department allowlist, and creates the same revocable opaque
session used by password login. The Taihu token is read only from the
permission-restricted `tokenFile`; it is never accepted in a URL or persisted
authentication state.

### Verified identity headers

An authenticated `GET` or `HEAD` request to `/auth/verify` still returns `204`
and the legacy `X-Dsh-Auth-User-Id: admin`, username, and edge-role headers.
For an external (IOA) session it also returns URL-encoded, validated profile
headers: `X-Dsh-Auth-Subject`, `X-Dsh-Auth-Username`,
`X-Dsh-Auth-Display-Name`, and optional `X-Dsh-Auth-Picture`. `Subject` is the
stable external account key; `X-Dsh-Auth-Roles` describes only the dsh-auth
edge and must not be used as an application role. The managed Caddy removes
client-supplied values before `forward_auth` and copies only verifier output to
the upstream. Profile fields are bounded to 512 UTF-8 bytes and reject control
characters; picture URLs must be HTTPS without credentials or fragments.

## Reset the password

Signed-in administrators can open **Settings → General → Reset password**, enter the current password, and set a new one. That updates the stored hash and signs out other browser sessions; it does not rotate the session secret.

If the current password is unavailable, operators with root on an installation created by `setup` can run the interactive reset:

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
  --admin-bootstrap password \
  --admin-username operator \
  --login-token disabled \
  --mode http \
  --listen-address 10.0.0.20 \
  --http-port 8080
```

Do not use this mode on an untrusted network. HTTPS is the production default.

## TLS terminated by an outer reverse proxy

Operators may keep certificates and public TLS in a same-host or same-network-namespace ingress, load balancer, or reverse proxy while retaining the managed dsh-auth Caddy as the only authentication edge that can reach DSH:

```sh
sudo dsh-auth setup \
  --admin-bootstrap login-token \
  --login-token enabled \
  --mode http \
  --listen-address 127.0.0.1 \
  --http-port 8080 \
  --behind-tls-proxy
```

This mode accepts only a loopback listener. The outer proxy must connect to that listener from loopback and must overwrite `X-Forwarded-Host`, `X-Forwarded-Proto`, and `X-Real-IP`; the forwarded protocol must be `https`. Missing forwarding metadata is rejected. dsh-auth preserves the public authority for exact Origin checks, uses relative login redirects, and emits `Secure`, `__Host-` cookies even though its inner hop is HTTP.

The outer proxy, its certificates, public address, and port remain operator-owned. Setup does not discover, reload, or modify them, and their changing public origin is not part of the setup fingerprint. Do not expose the inner listener, use a path prefix as an authentication secret, or let the outer proxy append client-supplied forwarding headers.

TLS termination and authentication enforcement remain separate ownership boundaries in this topology. The outer proxy does not need to know Harness routes or dsh-auth session semantics, and it must never proxy any path directly to Harness. dsh-auth deliberately retains its managed Caddy so operators do not have to reproduce complete `forward_auth` coverage for pages, APIs, downloads, SSE, and WebSockets in an existing gateway. Using an operator-managed Caddy, Nginx, ingress, or load balancer as the authentication edge is not a supported deployment mode.

## Doctor, uninstall, and v1 reinstall

`doctor` checks the ownership record, file permissions, the exact DSH service, root-executable safety, Caddy version and checksum, `caddy validate`, and service state:

```sh
sudo dsh-auth doctor
sudo dsh-auth doctor --json
```

Runtime authentication events use the Cordis logger name `dsh-auth`. The managed Caddy service writes security-sensitive access events to `/var/lib/dsh-auth-caddy/access.log`. Collect the application journal, restricted access-log files, and read-only health report:

```sh
sudo journalctl -u dsh-web.service --since '1 hour ago'
sudo ls -lh /var/lib/dsh-auth-caddy/access.log*
sudo tail -n 200 /var/lib/dsh-auth-caddy/access.log
sudo dsh-auth doctor --json
```

Authentication logs contain fixed event names, outcomes, authentication methods, and a deployment-scoped irreversible client identifier. They do not contain submitted usernames, passwords, hashes, raw login tokens, cookies, CSRF values, session identifiers, request bodies, or complete request URLs. Application warnings and errors have a shared budget of 60 events per minute; excess events are suppressed and summarized as `auth.logging.suppressed` when logging resumes in the next window. Successful state changes and startup events are not sampled.

Caddy access logs only security-sensitive login, token, logout, administrator, and public-verify paths; routine SPA and API traffic is skipped, and request and response headers are omitted. The active file rolls after 10 MiB; at most three gzip-compressed archives are retained for up to seven days, bounding nominal uncompressed storage near 40 MiB. Operators must still treat these files as sensitive because they contain client addresses and request paths. Keep journald globally bounded as well, and redact private hosts, paths, addresses, and account information before sharing a support bundle.

`uninstall --dry-run` lists only files and profile changes proven by the ownership record. Interactive uninstall requires typing `uninstall`; automation requires the exact `--authorize-uninstall` flag. The independent Caddy unit is removed; a user-installed Caddy or Nginx is never touched. An adopted, externally pre-installed bundle is preserved and simply becomes dormant again.

```sh
sudo dsh-auth uninstall --dry-run
sudo dsh-auth uninstall
```

schema v1 ownership records, old Nginx flags, and old plugin identity fields are refused with a reinstall diagnosis. There is no automatic migration. Old sessions become invalid after uninstall and a new setup.

## Managed upgrades

`upgrade` moves a healthy v2 installation to the build of the currently installed global CLI. Install the newer CLI first, then run:

```sh
sudo npm install -g dsh-auth@0.2.3
sudo dsh-auth upgrade
```

The profile bundle, bundled Caddy binary, environment marker, ownership record, and both services move together; administrator credentials, the session secret, and existing sessions survive. Any failing step rolls everything back to the recorded build. Same-version reinstalls and downgrades are refused, and `--package /path/dsh-auth-VERSION.tgz` pins an offline source. Interactive upgrade requires typing `upgrade`; automation requires `--non-interactive --authorize-upgrade`.

Updating the profile bundle through plain `dsh plugin` (instead of `dsh-auth upgrade`) creates version drift. The Web service then fails closed on restart instead of running an unverified build behind the authentication edge. `doctor` reports the drift with a fixed recovery order:

```sh
dsh plugin --profile web add <recorded-package-spec>   # restore the recorded build
sudo dsh-auth doctor                                   # must report healthy again
sudo dsh-auth upgrade                                  # only then upgrade
```

If the old artifact is no longer available or restores to a different build, doctor keeps failing: pin the recorded version from your trusted source, or uninstall and set up again.

## Experience environment deployment

The manual [Deploy experience environment workflow](.github/workflows/experience-deploy.yml) deploys a selected development ref to one protected GitHub Environment over a pinned SSH host key. It creates a private `-experience.<run-id>.<attempt>` prerelease tarball, performs the first non-interactive `setup`, and uses the transactional `upgrade` path on later runs. It never publishes npm or creates a GitHub Release. Configure the environment variables and secrets described in [`docs/experience-deploy.md`](docs/experience-deploy.md); keep the SSH account dedicated, require `sudo -n`, and retain the server-side artifact referenced by the ownership record for offline rollback.

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

JSON output uses schema version 2 and includes the command, status, exit code, redacted actions, and structured diagnostics.

## Docker and offline images

Build and pin the exact npm tarball, then install it into the DSH profile without registry access:

Replace `X.Y.Z` with the version in the packed artifact's filename.

```sh
corepack pnpm pack --pack-destination packed
dsh plugin --profile web add --offline --config.auto-install-peers=false /artifacts/dsh-auth-X.Y.Z.tgz
```

Generate deterministic runtime files without invoking systemd, a package manager, or a host Caddy binary:

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

The output directory contains `dsh-auth.env`, file-backed credentials, authentication state, a login-token directory, and a Caddyfile. Copy or mount them into fixed image paths and explicitly wire the environment file and Caddy config. The same tarball already contains linux-x64 and linux-arm64 Caddy binaries; setup copies the current architecture after checksum verification and never downloads a binary. [`deploy/docker/Dockerfile.install`](deploy/docker/Dockerfile.install) shows the offline profile layer.

## Security behavior and limits

- Production cookies are `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, and `__Host-` prefixed. Plain HTTP uses an explicit compatibility cookie mode.
- Argon2id hashes and random session secrets live in separate permission-restricted files. Persistent opaque sessions use a `0600` authentication-state document.
- Login, logout, token redemption, and first-time administrator setup enforce CSRF plus exact Origin/Referer checks after trusted-proxy resolution. Authentication responses are `no-store`.
- Version 2 supports one administrator identity (`admin`) per managed installation. Password and token initialization are an explicit choice. Registration, self-service account recovery, MFA, databases, multi-account policy, and multi-tenancy are outside this release.
- The managed dsh-auth Caddy is the only authentication edge allowed to reach Harness. It is normally the public listener; with `--behind-tls-proxy`, an operator-owned proxy is public but may reach only the managed edge. A standard reverse proxy cannot immediately revoke an already-open WebSocket. Deployments requiring immediate stream termination need a connection-aware edge.

Security reports follow [`SECURITY.md`](SECURITY.md).

## Development

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm run check
corepack pnpm run check:caddy
corepack pnpm run test:e2e
corepack pnpm pack --pack-destination packed
node scripts/installer-e2e.mjs packed/dsh-auth-X.Y.Z.tgz
```

Replace `X.Y.Z` with the version in `package.json`.

`test:e2e` packs the current checkout, installs it into a disposable DSH profile, and drives a real TLS Caddy edge plus a headless browser. It verifies unauthenticated denial, login-token issue and redemption, first-time administrator setup, password login, the protected SPA/API/download/WebSocket paths, session renewal and restart persistence, and Settings sign-out revocation. It requires OpenSSL, `ss`, and Chrome or Chromium; set `DSH_E2E_CHROME_BIN` when the browser is not installed at a standard Linux path. Without `DSH_E2E_CADDY_BIN`, the test prepares a checksum-verified official Caddy `v2.11.4` binary for isolation only.

Contributors should read [`AGENTS.md`](AGENTS.md). Installer architecture and maintenance checks are in [`docs/installer.md`](docs/installer.md).

Stable npm and GitHub releases are dispatched from the [Release workflow](.github/workflows/release.yml); maintainers should update the [changelog](CHANGELOG.md) and follow [`docs/releasing.md`](docs/releasing.md) first.
