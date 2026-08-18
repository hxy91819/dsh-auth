# Security policy

## Supported versions

Until the first stable release, only the latest source revision and the latest released `0.x` artifact receive security fixes. Older prereleases may contain known vulnerabilities and should not remain deployed.

Keep `dsh-auth`, DeepSeek Harness, Node.js, Caddy, and the operating system on supported versions. A deployment using an unreviewed Harness version is outside the tested compatibility and security boundary.

## Reporting a vulnerability

Use the repository host's private security-advisory feature. If that is unavailable, contact the maintainer through a private channel agreed outside this repository. Do not open a public issue containing credentials, cookies, password hashes, exploit details, private hostnames, logs, or deployment configuration.

Include the affected version, impact, minimal reproduction, deployment mode, and whether the issue has been disclosed elsewhere. Use synthetic accounts and redact secrets. Maintainers should acknowledge a report within seven days and coordinate remediation and disclosure timing with the reporter.

## Security objective

`dsh-auth` adds a single-account authentication gate in front of the DeepSeek Harness Web application without modifying Harness. Its objective is to prevent unauthenticated remote clients from reaching the Harness browser application, API, downloads, SSE endpoints, or WebSocket handshakes through the public listener.

This package provides authentication, not tenant isolation or fine-grained authorization. The configured user ID and roles are identity metadata; they do not create an independent Harness RBAC system. A successful login receives the authority already available to the configured Harness deployment, which may include reading workspaces, changing settings and credentials, starting agents, and executing tools.

## Trust boundaries

### Public network to Caddy

Caddy is the only supported public listener and is the authentication enforcement point. It terminates TLS, validates the public Host, applies request limits and security headers, calls the internal authentication subrequest, and proxies authenticated HTTP, downloads, SSE, and WebSocket handshakes.

Every public path other than the intended `/auth/*` interface must pass `forward_auth`. This includes the SPA fallback, `/api`, `/api/*`, `/api/session.export`, `/api/events.mux`, `/api/events.host`, `/plugins/*`, and `/plugins/events`. The upstream `/auth/verify` endpoint must remain reachable only through Caddy's internal `forward_auth` subrequest and must return not found when requested publicly.

The generated HTTPS configuration accepts only the configured public hostname. Plain HTTP accepts only the configured literal private or loopback IP. Protected state-changing requests and browser WebSocket handshakes require an exact public Origin or Referer after trusted-proxy resolution; sibling subdomains are not trusted origins.

### Caddy to Harness

Harness must bind only to the configured loopback address and port. Do not expose that port through another interface, reverse proxy, container port publication, SSH tunnel, service mesh route, or load balancer that bypasses Caddy. Check both IPv4 and IPv6 reachability after every deployment change.

Loopback is a network exposure control, not a local-user security boundary. Any local process that can connect directly to the Harness port bypasses the Caddy authentication gate. Deploy on a dedicated host or in a network namespace/container that does not contain mutually untrusted users or workloads. If the host threat model includes hostile local users, add operating-system isolation that prevents them from reaching the upstream port; `dsh-auth` alone is insufficient.

Only explicitly configured proxy IP addresses are trusted to supply `X-Forwarded-*` and client-address headers. Adding a public, shared, or attacker-reachable address to `DSH_AUTH_TRUSTED_PROXY_ADDRESSES` allows that peer to influence Origin checks and login rate-limit identity.

### Application and host

The DSH process, Cordis loader, installed plugins, Caddy worker and configuration, Node.js runtime, service account, and host root account are trusted computing base. Compromise of any of them can bypass authentication, capture passwords or sessions, alter proxied responses, or access Harness data directly.

All authenticated application content shares one browser origin. An XSS vulnerability in Harness or any same-origin plugin can act with the current authenticated session; `HttpOnly` cookies prevent direct cookie reads but do not prevent same-origin requests. `dsh-auth` does not sandbox third-party plugins.

## Required deployment invariants

A production deployment is within the supported boundary only while all of these conditions hold:

- Caddy is the sole externally reachable listener and uses the checksum-verified `v2.11.4` binary selected from the self-contained `dsh-auth` package.
- Harness listens on the exact configured loopback upstream and is not reachable through any bypass path.
- HTTPS is used with a valid certificate and key, TLS 1.2 or newer, and the configured public hostname. TLS must not be silently downgraded between the browser and Caddy.
- Production cookies remain `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, host-only, and `__Host-` prefixed.
- `/auth/verify` remains internal, and the catch-all protected location continues to cover current and future Harness routes.
- Caddy overwrites proxy identity headers as rendered; an outer proxy must not be added without explicitly reviewing Host, scheme, client-address, and Origin handling.
- The authentication state, session secret, installer state, environment file, and login-token directory retain their required ownership and modes.
- System time is trustworthy enough for session expiry, idle expiry, cookie expiry, token expiry, and TLS validation.
- Operators run `dsh-auth doctor` after changes to Caddy, systemd, the DSH profile, permissions, or managed files.

Removing or weakening any invariant requires a new security review. Do not compensate for a broken boundary with obscurity, an unadvertised port, or a strong password alone.

## Authentication and browser protections

- Passwords are verified against a resource-bounded Argon2id hash. Login failures do not reveal whether the username or password was incorrect.
- Login attempts are rate-limited at the application layer. Rate limiting reduces online guessing and resource abuse but is not a denial-of-service guarantee against distributed sources.
- Login and logout use signed double-submit CSRF values and exact Origin/Referer validation.
- Protected unsafe methods and browser WebSocket handshakes are checked at the authentication subrequest before Caddy rewrites the upstream Origin expected by Harness.
- Return targets accept only absolute paths on the current origin. Authentication and account responses use `no-store`; HTML receives a restrictive CSP and framing protections.
- Session cookies contain signed opaque random tokens. Authentication also requires a matching server-side session record, allowing logout and administrative secret rotation to revoke sessions.

Authentication secrets are not bearer API tokens and the package does not expose a supported non-browser token-authentication interface.

## Session lifecycle and storage

Keep `DSH_AUTH_SESSION_STORE_FILE` on local storage owned by the DSH service user. The plugin creates it with mode `0600` and refuses group- or world-accessible state on POSIX systems. Do not publish, share, or place the file in a repository.

One authentication-state document supports one DSH process. Do not share it between concurrent processes or replicas; multiple replicas require a coordinated session provider with equivalent atomicity, expiry, capacity, and revocation guarantees.

Treat backups and snapshots of the authentication state as sensitive. Restoring an older document while retaining the same session secret can restore a previously valid server-side session record. Rotate the session secret after restoring authentication state, cloning a machine, or recovering from an untrusted snapshot.

Logout revokes the stored session and clears browser cookies. Rotating the session secret invalidates every existing cookie and persisted session. A standard reverse-proxy authentication check cannot terminate a WebSocket that has already upgraded; revocation applies to its next handshake. Deployments requiring immediate stream termination need a connection-aware edge.

## Passwords, secrets, and managed files

Passwords may enter setup only through hidden interactive input, stdin, or a caller-managed secret file. They must not appear in command arguments, environment configuration, plans, logs, fixtures, support bundles, or repository content. `dsh-auth` persists only the Argon2id hash.

System setup stores the password hash and random session secret in separate root-owned, DSH-service-group-readable `0640` files below `/etc/dsh-auth`. Runtime credential-file sources must be regular files rather than symbolic links. On POSIX systems they may be group-readable for the service account, but must not be group-writable or accessible by others.

The session secret protects cookie and CSRF signatures and must be generated randomly. Exposure requires rotation. Exposure of a password hash permits offline password guessing and requires choosing a new password as well as rotating sessions.

`/etc/dsh-auth/install-state.json` is a root-only `0600` ownership and recovery record. It contains managed paths and deployment metadata but no password or session-secret value. Treat invalid state, unexpected permission changes, or unmanaged files at recorded targets as an incident; do not delete or overwrite files until ownership is established.

`reset-password` validates the ownership record and credential files, replaces both credentials, revokes sessions, and restores the prior files if an active DSH service cannot restart. Non-interactive reset requires explicit authorization. Review the result and run `doctor` after recovery or rollback failures.

## Root installer boundary

System `setup`, `reset-password`, and `uninstall` run with root authority. The installer validates paths, service names, profile names, Caddy inputs, ownership records, root-executed binaries, and writable path components before mutation. Commands use fixed executables and argv arrays rather than shell interpolation.

Review `dsh-auth plan` before authorizing setup. The single `dsh-auth` artifact carries both supported official Caddy binaries; setup selects and verifies the current architecture before mutation. Setup never downloads a binary and never probes, reloads, or reuses a user Caddy or Nginx service.

The installer owns only paths recorded in its validated state. Existing files or packages that it cannot prove ownership of are conflicts. Do not edit managed files in place or fabricate an ownership record. Use `--output-dir` when building images or generating artifacts without granting service-manager or host-filesystem authority.

Installer safety does not protect against a malicious package artifact, compromised package registry, compromised operating-system repository, or already-compromised root environment. Pin and verify the package source appropriate to the deployment's supply-chain policy.

## Explicitly unsupported or out of scope

- Plain HTTP on an untrusted network. HTTP mode provides a login flow but cannot prevent interception or modification of credentials and sessions.
- Mutually untrusted local users or workloads that can reach the Harness loopback port.
- A compromised DSH service account, root account, Caddy process/configuration, Cordis plugin, Harness package, or same-origin browser application.
- Immediate revocation of already-open WebSockets.
- Multi-account policy, registration, account recovery, MFA, SSO, per-user authorization, tenant isolation, and audit-grade identity attribution.
- Multiple concurrent DSH processes sharing the JSON authentication-state document.
- Protection of data after an authenticated user or agent intentionally exports it, writes it to an unsafe location, or sends it through a configured tool or model provider.
- Availability against host exhaustion, a sufficiently distributed denial-of-service attack, or failure of external TLS, DNS, package-registry, and operating-system infrastructure.

## Deployment incidents

For suspected compromise:

1. Remove public reachability at the network edge without exposing the Harness upstream.
2. Preserve the installer state, relevant configuration, and redacted logs for investigation.
3. Rotate the session secret to revoke browser sessions. Replace the password if it or its hash may have been exposed.
4. Stop trusting restored or copied session state; archive it securely and start with an empty store after rotation.
5. Inspect Caddy routes, alternate listeners, systemd units, DSH profiles, plugin inventory, file ownership, and recent package changes.
6. Update DSH, Node.js, Caddy, `dsh-auth`, and the operating system to fixed versions, then run `dsh-auth doctor` and the deployment's external reachability checks.
7. Re-enable public traffic only after the original boundary is restored and credentials issued before containment are considered invalid.

Do not publish incident artifacts without removing cookies, hashes, secrets, private paths, hostnames, account identifiers, and user data.
