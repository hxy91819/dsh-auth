# dsh-auth

`dsh-auth` is an installable DeepSeek Harness/Cordis authentication bundle for deployments that put Nginx in front of the DSH Web app. It adds a standalone single-account login and account page, a bilingual sign-out action in the real Harness sidebar, signed server-revocable sessions, and an internal verification endpoint for Nginx `auth_request`. It does not fork or patch DeepSeek Harness.

The package is published on npm as [`dsh-auth`](https://www.npmjs.com/package/dsh-auth). A checkout and a locally packed tarball remain supported for development and deterministic offline image builds.

## Architecture

Nginx is the only public listener. It keeps the deployment's existing certificate automation and TLS policy, applies an outer login rate limit and security headers, calls the plugin's internal verification route, and proxies authenticated traffic to DSH. DSH listens on `127.0.0.1:3080` when both processes share a host, or on a non-published internal container address when they do not.

The authentication UI follows Harness's font, color, spacing, control, and dark-mode tokens. Login and account pages are server-rendered without client-side JavaScript and read Harness's live `locale` and `ui-theme` Settings namespaces on every request. The authenticated SPA loads the package's browser half through Harness's official client-module loader and registers a responsive `sidebar.footer.action` sign-out row. The official index-tap registry publishes the validated authentication path to that browser half, so custom route prefixes do not require rebuilding the client. Its label and tooltip use Harness locale dictionaries and its colors follow the active Harness theme. An unspecified Harness locale follows the browser language and the theme defaults to `system`, matching Harness. The authentication plugin does not render preference controls, accept preference query parameters, or issue preference cookies.

The bundle uses DSH's public WebServer route and index-tap registries. The verified DSH routes in `0.1.0-rc.6` are:

| Traffic | DSH route | Nginx behavior |
|---|---|---|
| SPA and static assets | `/` fallback | unauthenticated navigation gets a safe login redirect |
| RPC | `/api/*` | unauthenticated requests get `401` |
| WebSocket downlinks | `/api/events.mux`, `/api/events.host` | authentication runs before Upgrade; denial is `401` |
| Session-log download | `/api/session.export` | authenticated `HEAD`/`GET`, streaming proxy |
| Client bundles | `/plugins/*` | authenticated static proxy |
| Development reload stream | `/plugins/events` | authenticated, unbuffered SSE proxy |
| Authentication | `/auth/*` | public login plus session/account/logout handlers |
| Verification | upstream `/auth/verify` | reachable publicly only through Nginx's `internal` subrequest location |

No Nginx `sub_filter`, DOM probing, or fragile asset replacement is used. In explicit plain-HTTP mode, the supported index tap loads an early same-origin compatibility script before the SPA module script, so a standard `script-src 'self'` policy remains usable. It defines `crypto.randomUUID` only when the browser omits it outside a secure context and derives UUID v4 values exclusively from `crypto.getRandomValues`. HTTPS mode does not add or serve the bootstrap. The Harness sidebar action is the primary logout surface; `/auth/account` remains a standalone fallback.

## Requirements and compatibility

- Node.js `>=24.7.0`, because the package uses Node's built-in Argon2id implementation and ships with no runtime dependencies.
- DeepSeek Harness `0.1.0-rc.6` client module loader and sidebar slots, with `@deepseek-ai/cordis` 4.x, `@deepseek-ai/dsh-host-webserver` `>=0.1.0-rc.5 <0.2.0`, and `@deepseek-ai/dsh-settings` `>=0.1.0-rc.5 <0.2.0`.
- Nginx 1.24 or newer with `ngx_http_auth_request_module` and TLS support. The template keeps the compatible `listen ... http2` form; CI installs Ubuntu's distro package and the local integration baseline is Nginx 1.26.
- A TLS certificate managed by the deployment. `dsh-auth` does not replace certificate issuance or renewal.

The real integration baseline is DSH `0.1.0-rc.6`, Cordis `4.0.1`, Node `24.15.0`, and Nginx `1.26.3`.

## Install from npm

Install the published package into the Web profile and pin the version for reproducible deployments:

```sh
dsh plugin --profile web add dsh-auth@0.1.9
dsh --profile web --dump-config
```

The package is unscoped and public. DeepSeek Harness and its Web profile supply the optional Cordis, server, Settings, React, and client-platform peer packages.

## Install from a checkout

Install, check, and build:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm run check
corepack pnpm run check:nginx
```

Install the checkout into the Web profile. `dsh plugin` records it as a local dependency and appends its bundle layer:

```sh
dsh plugin --profile web add "$PWD"
dsh --profile web --dump-config
```

Generate a password hash interactively; the prompt does not echo input. Generate the session secret separately:

```sh
node lib/cli.js hash > password-hash
node lib/cli.js secret > session-secret
chmod 600 password-hash session-secret
```

`dsh-auth hash --stdin` is also available for secret-manager automation. Do not put a password on the command line or in shell history.

Export identity and file paths in the DSH process environment:

```sh
export DSH_AUTH_USER_ID=replace-with-stable-user-id
export DSH_AUTH_USERNAME=replace-with-username
export DSH_AUTH_ROLES=admin
export DSH_AUTH_TRUSTED_PROXY_ADDRESSES=127.0.0.1,::1
export DSH_AUTH_PASSWORD_HASH_FILE="$PWD/password-hash"
export DSH_AUTH_SESSION_SECRET_FILE="$PWD/session-secret"
dsh web --port 3080
```

DSH treats `DSH_*` names as launch configuration and rejects them in its project `.env`; use a service manager, container env-file, or inherited environment. [`deploy/dsh-auth.env.example`](deploy/dsh-auth.env.example) contains placeholders only. Production secrets should be mounted outside the checkout, commonly under `/run/secrets`.

## Tarball and deterministic offline installation

Build and inspect a package artifact:

```sh
corepack pnpm pack
npm pack --dry-run
```

Install the exact tarball into a profile without registry access:

```sh
dsh plugin --profile web add --offline --config.auto-install-peers=false ./dsh-auth-0.1.9.tgz
```

The tarball contains both the Node plugin and `lib/client.js`, the closure bundle discovered by DSH's Web client loader. It has no installed runtime dependencies; DSH supplies the optional Host and browser platform peers. Pin and verify the tarball digest in production image builds. This artifact has the same contents as the npm registry artifact, so a Docker build can remain offline after the tarball is copied into its context.

`cordis.patch.yml` is the normal bundle layer. [`cordis.overlay.yml`](cordis.overlay.yml) supports advanced setups where the package is already resolvable in a profile but intentionally omitted from `dsh.profile.bundles`; pass it with `dsh --profile web --patch <path>`. Do not activate both files because they register the same row id.

## Nginx and certificates

[`deploy/nginx/dsh-auth.conf.template`](deploy/nginx/dsh-auth.conf.template) is an `http {}` include. Render only its declared placeholders so Nginx variables remain unchanged:

```sh
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
  < deploy/nginx/dsh-auth.conf.template > /etc/nginx/conf.d/dsh-auth.conf
nginx -t
```

`DSH_PUBLIC_SERVER_NAME` is the exact public hostname used for virtual-host selection. `DSH_PUBLIC_HTTPS_AUTHORITY` is the canonical redirect authority and may include a nonstandard HTTPS port. Unknown Host values receive `421` and never influence a redirect. Point the certificate placeholders at files already maintained by the product's ACME/certificate automation. Keep its HTTP challenge location if that automation needs one; add the challenge exception before the template's HTTP redirect. Reload Nginx only after `nginx -t` passes.

The template overwrites the upstream `Host` and `Origin` with the loopback DSH authority so DSH's DNS-rebinding fence still passes, while it forwards the real browser origin and trusted proxy fields only to `/auth/*` for CSRF validation. Public authentication bodies are capped at 20 KiB before Nginx buffers them. The public `/auth/verify` path returns `404`; Nginx reaches it through `/_dsh_auth_verify`, which is `internal`.

### Plain HTTP for isolated evaluation

The shipped Nginx template intentionally redirects to HTTPS. An isolated evaluation deployment may instead expose the protected server block with a plain `listen` directive, remove its TLS/HSTS directives, and set `DSH_AUTH_SECURE_COOKIES=false`. This explicit switch replaces the `__Host-` cookie names, omits `Secure` so browsers can retain the session over HTTP, and enables the Web Crypto compatibility bootstrap described above. It does not disable authentication, CSRF/origin checks, rate limiting, or loopback binding. Plain HTTP exposes credentials and sessions to network interception; never use it on an untrusted network or as a production default.

## Docker image integration

Run `pnpm pack`, copy the exact tarball beside [`deploy/docker/Dockerfile.install`](deploy/docker/Dockerfile.install), and provide a pinned DSH base image digest. Its install step uses `--network=none` and disables automatic peer downloads. No official DSH image name is assumed. See [`deploy/docker/README.md`](deploy/docker/README.md).

For two containers, expose DSH only on a private network and publish only Nginx. Update `DSH_UPSTREAM` to the internal service authority, give Nginx a stable private source IP, and set `DSH_AUTH_TRUSTED_PROXY_ADDRESSES` to that literal IP; never publish the DSH port or trust an entire shared subnet. For a single container, supervise both processes, keep DSH on loopback, and retain the loopback proxy default.

## Configuration

| Variable | Required/default | Meaning |
|---|---|---|
| `DSH_AUTH_USER_ID` | required | stable account id, retained if the display username changes |
| `DSH_AUTH_USERNAME` | required | login name and session display name |
| `DSH_AUTH_ROLES` | `admin` | comma-separated stable role ids |
| `DSH_AUTH_TRUSTED_PROXY_ADDRESSES` | `127.0.0.1,::1` | comma-separated literal Nginx source IPs allowed to supply forwarded origin/client fields |
| `DSH_AUTH_PASSWORD_HASH` / `_FILE` | exactly one | PHC-style Argon2id v=19 hash or absolute file path |
| `DSH_AUTH_SESSION_SECRET` / `_FILE` | exactly one | at least 32 bytes or absolute file path; rotation revokes all sessions |
| `DSH_AUTH_SECURE_COOKIES` | `true` | keep `Secure` and `__Host-` cookie names; set `false` only for an isolated plain-HTTP evaluation |
| `DSH_AUTH_SESSION_TTL_SECONDS` | `28800` | absolute session lifetime |
| `DSH_AUTH_IDLE_TTL_SECONDS` | `3600` | idle lifetime, not greater than the absolute lifetime |
| `DSH_AUTH_MAX_SESSIONS` | `16` | maximum live sessions for the single account |
| `DSH_AUTH_MAX_PASSWORD_BYTES` | `1024` | submitted password byte limit |
| `DSH_AUTH_LOGIN_WINDOW_SECONDS` | `60` | application login rate window |
| `DSH_AUTH_LOGIN_MAX_ATTEMPTS` | `5` | attempts per forwarded client in one window |
| `DSH_AUTH_LOGIN_BLOCK_SECONDS` | `300` | application block duration |

Configuration rejects ambiguous secret sources, relative secret-file paths, malformed or excessive Argon2 parameters, invalid account identifiers, and unsafe lifetimes before the route activates.

## Security model

- Session and CSRF cookies use `HttpOnly; Secure; SameSite=Lax; Path=/` and the `__Host-` prefix by default. The explicit plain-HTTP evaluation mode removes `Secure` and changes the names while preserving every other cookie attribute. Session cookies contain only a random opaque id and HMAC; live session state remains in memory for immediate server-side revocation. Language and appearance remain Harness-owned Settings and are never copied into authentication cookies.
- Password verification is Argon2id with a random salt and constant-time tag comparison. Unknown usernames run the same configured password hash before the generic failure response.
- Login and logout require a signed double-submit token and exact browser Origin/Referer validation after trusted-proxy resolution. The authenticated, no-store `GET /auth/csrf` endpoint issues the logout token used by the Harness sidebar action; logout remains a navigational `POST`. Only configured literal proxy IPs can supply forwarded origin or client fields.
- Authentication responses are `no-store`, return targets remain same-origin absolute paths, request bodies are bounded, and no credentials, cookies, request bodies, or auth failures are logged by the plugin.
- Nginx and the application enforce independent login limits. Nginx authenticates SPA, API, download, SSE, and WebSocket entry paths. DSH remains unreachable from external interfaces.

## Limitations and multi-account evolution

Version 1 intentionally has one configured account and an in-memory session store. A DSH restart, session-secret rotation, or plugin reload revokes every session. Multiple DSH replicas need a shared revocation/session provider before they can share one public endpoint.

Nginx authenticates a WebSocket when it is opened; HTTP mutations stop immediately after logout, but an already-open downlink cannot be rechecked by standard `auth_request`. Deployments that require cross-tab stream termination must close existing connections at the edge or add a connection-aware gateway.

Multi-account support should preserve the public session fields `{ userId, username, roles }`, replace configured password lookup with an identity store, and key workspace policy by stable `userId`. Database storage, registration, password recovery, MFA, tenant routing, and authorization inside DSH are out of scope for v1.

## Development

```sh
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run test
corepack pnpm run build
corepack pnpm run check:nginx
```

Tests drive real HTTP behavior, hardened cookie fields, login/logout, revocation, expiration, tampering, CSRF/origin handling, limiting, live Harness locale/theme changes, wide/rail sidebar rendering, bilingual copy, the HTTP Web Crypto bootstrap, and a live Cordis WebServer/Settings registration lifecycle. Security reports follow [`SECURITY.md`](SECURITY.md).
