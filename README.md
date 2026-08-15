# dsh-auth

[![npm version](https://img.shields.io/npm/v/dsh-auth.svg)](https://www.npmjs.com/package/dsh-auth)
[![CI](https://github.com/hxy91819/dsh-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/hxy91819/dsh-auth/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-auth.svg)](LICENSE)

Add a secure, single-account login to the DeepSeek Harness Web app without forking or patching Harness. `dsh-auth` supplies a bilingual login page, signed and revocable sessions, a native sign-out action in the Harness sidebar, and the Nginx `auth_request` integration that protects pages, APIs, downloads, and WebSockets.

## What you get

- A login and account experience that follows Harness language, theme, spacing, and responsive layout.
- Argon2id password hashing and opaque, server-revocable sessions.
- Safe return-to navigation with CSRF and Origin protection.
- Independent login rate limits in both Nginx and the application.
- A loopback-only Harness process behind the only public listener: Nginx.
- Installation from npm, a local checkout, or a pinned offline tarball.

Version 1 supports one configured account. Sessions survive page reloads and browser restarts until their idle or absolute expiry, but restarting DSH revokes all sessions because the session store is intentionally in memory.

## Requirements

- DeepSeek Harness Web `0.1.0-rc.6`.
- Node.js `>=24.7.0`.
- Nginx 1.24 or newer with `ngx_http_auth_request_module`.
- A TLS certificate for normal deployments. Plain HTTP is available only as an explicit evaluation mode.

The tested baseline is DSH `0.1.0-rc.6`, Cordis `4.0.1`, Node `24.15.0`, and Nginx `1.26.3`.

## Quick start

### 1. Install the plugin

Install the published package into the Harness Web profile. Pin the version for reproducible deployments:

```sh
dsh plugin --profile web add dsh-auth@0.1.10
dsh --profile web --dump-config
```

The package is public and unscoped. Harness supplies its optional Cordis, server, Settings, React, and client-platform peers.

### 2. Create the password hash and session secret

The following Bash commands keep the password out of command-line arguments and shell history. The password is read without echo, sent only to the hashing process, and then removed from the shell variable:

```bash
AUTH_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/dsh-auth"
DSH_AUTH_PACKAGE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/dsh-auth"
install -d -m 700 "$AUTH_DIR"

IFS= read -r -s -p 'Password: ' DSH_AUTH_TEMP_PASSWORD
printf '\n'
printf '%s' "$DSH_AUTH_TEMP_PASSWORD" |
  node "$DSH_AUTH_PACKAGE_DIR/lib/cli.js" hash --stdin > "$AUTH_DIR/password-hash"
unset DSH_AUTH_TEMP_PASSWORD

node "$DSH_AUTH_PACKAGE_DIR/lib/cli.js" secret > "$AUTH_DIR/session-secret"
chmod 600 "$AUTH_DIR/password-hash" "$AUTH_DIR/session-secret"
```

Production orchestrators should mount both files from a secret manager instead. Never store a plaintext password in configuration or pass one as a command-line argument.

### 3. Configure and start Harness

Choose a stable `userId`; keep it unchanged if the display username changes. Start DSH with the authentication configuration in its process environment:

```sh
AUTH_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/dsh-auth"
export DSH_AUTH_USER_ID=replace-with-stable-user-id
export DSH_AUTH_USERNAME=replace-with-username
export DSH_AUTH_ROLES=admin
export DSH_AUTH_TRUSTED_PROXY_ADDRESSES=127.0.0.1,::1
export DSH_AUTH_PASSWORD_HASH_FILE="$AUTH_DIR/password-hash"
export DSH_AUTH_SESSION_SECRET_FILE="$AUTH_DIR/session-secret"
dsh web --port 3080
```

DSH listens on `127.0.0.1:3080`; do not expose that listener publicly. For a persistent deployment, put these values in a service-manager environment file and run DSH under that service. DSH rejects `DSH_*` launch variables in its project `.env`; use inherited environment, a container env-file, or a service manager. The packaged [`deploy/dsh-auth.env.example`](deploy/dsh-auth.env.example) contains placeholders only.

### 4. Put Nginx in front

The packaged template is an Nginx `http {}` include. Point it at the loopback DSH listener and your existing certificate files:

```sh
DSH_AUTH_PACKAGE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/dsh-auth"
export DSH_UPSTREAM=127.0.0.1:3080
export DSH_HTTP_LISTEN=80
export DSH_HTTPS_LISTEN=443
export DSH_PUBLIC_SERVER_NAME=replace-with-public-hostname
export DSH_PUBLIC_HTTPS_AUTHORITY=replace-with-public-hostname
export DSH_TLS_CERTIFICATE=/etc/letsencrypt/live/replace-with-name/fullchain.pem
export DSH_TLS_CERTIFICATE_KEY=/etc/letsencrypt/live/replace-with-name/privkey.pem
export DSH_LOGIN_RATE=5r/m
export DSH_LOGIN_BURST=4

envsubst '${DSH_UPSTREAM} ${DSH_HTTP_LISTEN} ${DSH_HTTPS_LISTEN} ${DSH_PUBLIC_SERVER_NAME} ${DSH_PUBLIC_HTTPS_AUTHORITY} ${DSH_TLS_CERTIFICATE} ${DSH_TLS_CERTIFICATE_KEY} ${DSH_LOGIN_RATE} ${DSH_LOGIN_BURST}' \
  < "$DSH_AUTH_PACKAGE_DIR/deploy/nginx/dsh-auth.conf.template" |
  sudo tee /etc/nginx/conf.d/dsh-auth.conf >/dev/null
sudo nginx -t
sudo systemctl reload nginx
```

`DSH_PUBLIC_SERVER_NAME` is the exact public host used for virtual-host selection. `DSH_PUBLIC_HTTPS_AUTHORITY` is the canonical redirect authority and may include a nonstandard HTTPS port. Unknown Host values receive `421` and cannot influence redirects. Keep any ACME HTTP challenge exception required by your certificate automation.

### 5. Verify the deployment

Open `https://your-host/`. An unauthenticated page request should redirect to `/auth/login`; after login, the real Harness SPA should load and its sidebar should contain the bilingual sign-out action.

These quick checks cover the public edge behavior:

```sh
curl -I https://your-host/
curl -I https://your-host/api/session.list
curl -I https://your-host/auth/verify
```

Expect a login redirect for `/`, `401` for the unauthenticated API request, and `404` for the public verification path. Nginx alone can reach the internal verification location.

## Plain HTTP for isolated evaluation

The template defaults to HTTPS. For an isolated trusted-network evaluation, expose the protected server block with a plain `listen`, remove its TLS and HSTS directives, and set `DSH_AUTH_SECURE_COOKIES=false` in the DSH environment. This switches away from `Secure` and `__Host-` cookies and enables the same-origin Web Crypto compatibility bootstrap required by browsers that omit `crypto.randomUUID` outside a secure context.

Plain HTTP still enforces authentication, CSRF/Origin checks, rate limiting, and loopback binding, but it exposes credentials and sessions to network interception. Do not use it on an untrusted network or as a production default.

## Configuration

| Variable | Required/default | Meaning |
|---|---|---|
| `DSH_AUTH_USER_ID` | required | stable account id, retained if the display username changes |
| `DSH_AUTH_USERNAME` | required | login name and session display name |
| `DSH_AUTH_ROLES` | `admin` | comma-separated stable role ids |
| `DSH_AUTH_TRUSTED_PROXY_ADDRESSES` | `127.0.0.1,::1` | literal Nginx source IPs allowed to supply forwarded origin/client fields |
| `DSH_AUTH_PASSWORD_HASH` / `_FILE` | exactly one | Argon2id v=19 hash or absolute file path |
| `DSH_AUTH_SESSION_SECRET` / `_FILE` | exactly one | at least 32 bytes or absolute file path; rotation revokes all sessions |
| `DSH_AUTH_SECURE_COOKIES` | `true` | keep `Secure` and `__Host-` cookies; set `false` only for isolated HTTP evaluation |
| `DSH_AUTH_SESSION_TTL_SECONDS` | `28800` | absolute session lifetime |
| `DSH_AUTH_IDLE_TTL_SECONDS` | `3600` | idle lifetime, not greater than the absolute lifetime |
| `DSH_AUTH_MAX_SESSIONS` | `16` | maximum live sessions for the account |
| `DSH_AUTH_MAX_PASSWORD_BYTES` | `1024` | submitted password byte limit |
| `DSH_AUTH_LOGIN_WINDOW_SECONDS` | `60` | application login-rate window |
| `DSH_AUTH_LOGIN_MAX_ATTEMPTS` | `5` | attempts per forwarded client in one window |
| `DSH_AUTH_LOGIN_BLOCK_SECONDS` | `300` | application block duration |

Invalid identifiers, ambiguous secret sources, relative secret-file paths, unsafe lifetimes, and malformed or excessive Argon2 parameters fail during plugin loading.

## Docker and offline installation

Build a deterministic tarball and inspect its contents:

```sh
corepack pnpm pack
npm pack --dry-run
```

Install the exact artifact into a profile without registry access:

```sh
dsh plugin --profile web add --offline --config.auto-install-peers=false ./dsh-auth-0.1.10.tgz
```

The tarball has no installed runtime dependencies and includes the Node plugin, browser bundle, Nginx template, and Docker integration files. Pin and verify its digest in production builds. [`deploy/docker/Dockerfile.install`](deploy/docker/Dockerfile.install) performs the profile installation with `--network=none`; see [`deploy/docker/README.md`](deploy/docker/README.md).

For two containers, publish only Nginx and keep DSH on a private network. Give Nginx a stable private source IP and list that literal address in `DSH_AUTH_TRUSTED_PROXY_ADDRESSES`; never trust an entire shared subnet.

## Security and limitations

- Session and CSRF cookies use `HttpOnly; Secure; SameSite=Lax; Path=/` and the `__Host-` prefix by default.
- Password verification uses Argon2id and constant-time tag comparison. Unknown usernames run the configured hash before returning the same generic failure.
- Login and logout require a signed double-submit token and exact Origin/Referer validation after trusted-proxy resolution.
- Authentication responses are `no-store`; credentials, cookies, request bodies, and authentication failures are not logged by the plugin.
- Nginx authenticates SPA, API, download, SSE, and WebSocket entry paths. DSH remains unreachable from external interfaces.
- Logout revokes the session immediately. An already-open WebSocket cannot be rechecked by standard Nginx `auth_request`; deployments requiring immediate stream termination need a connection-aware edge.
- Multiple DSH replicas require a shared session and revocation provider. Registration, recovery, MFA, databases, multi-account policy, and multi-tenancy are outside version 1.

Future multi-account support can preserve the public session fields `{ userId, username, roles }`, replace configured password lookup with an identity store, and key workspace policy by stable `userId`.

Security reports follow [`SECURITY.md`](SECURITY.md).

## How it works

Nginx is the only public listener. It applies security headers and an outer login limit, calls the plugin's internal verification route, and proxies authenticated traffic to DSH. The plugin uses Harness's public WebServer, Settings, index-tap, client-module, locale, and sidebar-slot extension points; it does not fork Harness, replace assets, probe the DOM, or use Nginx `sub_filter`.

| Traffic | DSH route | Nginx behavior |
|---|---|---|
| SPA and static assets | `/` fallback | unauthenticated navigation redirects safely to login |
| RPC | `/api/*` | unauthenticated requests receive `401` |
| WebSocket downlinks | `/api/events.mux`, `/api/events.host` | authentication runs before Upgrade; denial is `401` |
| Session-log download | `/api/session.export` | authenticated `HEAD`/`GET`, streaming proxy |
| Client bundles | `/plugins/*` | authenticated static proxy |
| Development reload stream | `/plugins/events` | authenticated, unbuffered SSE proxy |
| Authentication | `/auth/*` | public login plus session, account, and logout handlers |
| Verification | upstream `/auth/verify` | reachable only through Nginx's `internal` subrequest location |

`cordis.patch.yml` is the normal bundle layer. [`cordis.overlay.yml`](cordis.overlay.yml) is for advanced deployments where the package is already resolvable but intentionally omitted from `dsh.profile.bundles`; do not activate both files.

## Development

Install a checkout, run the complete checks, and add the checkout to the Web profile:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm run check
corepack pnpm run check:nginx
dsh plugin --profile web add "$PWD"
```

Tests cover real HTTP behavior, cookie security, login/logout, revocation, expiration, tampering, CSRF/Origin handling, rate limiting, live Harness locale/theme changes, responsive sidebar rendering, bilingual copy, the HTTP Web Crypto bootstrap, and Cordis registration lifecycle behavior.
