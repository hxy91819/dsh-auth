# Security policy

## Supported versions

Until the first stable release, only the latest source revision and latest released `0.x` artifact receive security fixes.

## Reporting a vulnerability

Use the repository host's private security-advisory feature once a public repository exists. Before then, contact the maintainer through a private channel agreed outside this repository. Do not open a public issue containing credentials, cookies, hashes, exploit details, private hostnames, logs, or deployment configuration.

Include the affected version, impact, minimal reproduction, and whether the issue has been disclosed elsewhere. Use synthetic accounts and redact secrets. Maintainers should acknowledge a report within seven days and coordinate remediation and disclosure timing with the reporter.

## Session state

Keep `DSH_AUTH_SESSION_STORE_FILE` on local storage owned by the DSH service user. The plugin creates it with mode `0600` and refuses group- or world-accessible state on POSIX systems. Do not publish, share, or place the file in a repository even though its opaque tokens still require a valid signed cookie. Do not share one file between concurrent DSH processes; multiple replicas require a coordinated session provider.

## Installer state and credentials

System setup stores an Argon2id password hash and a random session secret in separate root-owned, DSH-service-group-readable `0640` files below `/etc/dsh-auth`; the plaintext password is read only from hidden input, stdin, or a caller-managed `0600` secret file and is never persisted by dsh-auth. `/etc/dsh-auth/install-state.json` is root-only `0600` and records exact managed paths and package ownership without secret values. Treat unexpected permission changes, an invalid ownership record, or files at managed targets without a record as a deployment incident; the installer fails closed instead of overwriting or deleting them.

Automatic Nginx installation uses fixed argv for explicitly supported operating-system package managers and their configured repositories. It requires a separate authorization and never removes the shared Nginx package. Review `dsh-auth plan` before granting package-install or uninstall authorization in automation.

## Deployment incidents

For suspected compromise, remove public reachability, rotate the session secret to revoke every session, replace the password hash if credentials may be exposed, inspect Nginx and service logs without publishing them, and update DSH, Node, Nginx, and `dsh-auth` to fixed versions.
