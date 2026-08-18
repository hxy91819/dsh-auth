# Installer architecture

Read this document before changing `setup`, `plan`, `doctor`, `reset-password`, `uninstall`, Caddy platform-package verification, systemd integration, managed paths, JSON output, or installer exit codes.

## Public surface

`setup` and `plan` accept the same validated v2 `SetupRequest`. Interactive input and non-interactive flags only construct that request; both call `discoverHost()` and `prepareSetup()`. `setup --dry-run` selects the `plan` path before preparation. Secret input is represented by a `PasswordSource` descriptor and is read only by `executeSetup()` after all prerequisite and interactive confirmations pass.

`doctor` is read-only. `reset-password` reads the same validated ownership record, updates the v2 authentication-state document, rotates the session secret to revoke sessions, and restores both files if an active DSH service cannot be restarted. `uninstall` reads the state record and removes only recorded files, the owned `dsh-auth-caddy.service`, and the profile package installed by the recorded setup. `issue-login-token` reads the same ownership record or explicit container inputs and prints one bearer login URL. The legacy `hash` and `secret` commands remain narrow credential helpers; they are not part of installation planning.

`issue-login-token` validates every input before it generates any random token. Without `--auth-state-file` it requires root and a completed system installation whose record enables tokens; it derives the authentication state file, the `login-tokens` directory, the service UID/GID, and the public origin from that record and rejects drift, schema v1, and origin tampering. With `--auth-state-file` and `--public-origin` together it runs in container mode: the state file must be a real `0600` regular file, the caller must be root or the file owner, the sibling `login-tokens` directory must be a real `0700` directory owned by the state owner, and the adjacent `dsh-auth.env` must declare `DSH_AUTH_LOGIN_TOKEN_ENABLED=true`. `--public-origin` accepts one http or https origin without userinfo, path, query, or fragment; plain HTTP further requires a private, ULA, or loopback literal address. `--ttl-seconds` accepts 60-300 and defaults to 300. Interactive use asks for the exact word `issue-login-token`; non-interactive use requires `--non-interactive` with `--authorize-login-token-issue`. The raw token appears only in the successful human URL line or the JSON v2 success document, which is the only command allowed to return a bearer secret. If stdout fails after the token file is published, the file is kept until it expires and the error never contains the token.

CLI command names, flag names, `--name value` or `--name=value` syntax, JSON schema version 2, and exit codes are public automation interfaces. Global flags may precede the command. `--json` is output format only and does not disable prompts. JSON documents include `schemaVersion`, the command, status, exit code, redacted actions, and structured diagnostics. New flags and diagnostic codes may be added. Renaming, removing, or changing the meaning of an existing flag, JSON field, or exit code requires an explicit compatibility decision.

v2 setup requires `--admin-bootstrap password|login-token` and `--login-token enabled|disabled`. Password initialization also requires `--admin-username` and, when the plan is ready, exactly one password source. Login-token initialization requires token enabled and rejects username and password sources. `--nginx`, `--authorize-nginx-install`, `--user-id`, `--username`, `--roles`, and `--dsh-bin` are removed without aliases.

## State machine

```text
request -> validate -> discover -> blocked | ready | unchanged
                                      |
                                      v
                       journal(status=installing)
                                      |
                         package/profile changes
                                      |
                       Caddy copy + permissioned file writes
                                      |
                    caddy validate -> systemd reload
                                      |
                       DSH restart -> enable dsh-auth-caddy.service
                                      |
                         state(status=installed)
```

The first managed file is the adjacent root-only bootstrap journal `/etc/dsh-auth.installing.json` with `status: installing`. Setup creates and secures the configuration directory, then atomically renames that journal to `/etc/dsh-auth/install-state.json`; a retry recognizes either location. Every later file, directory, DSH profile package action, and service activation attempt is recorded before that mutation starts, so recovery can reconcile a crash between external changes. A retry with the same fingerprint first rolls back this journal. A completed identical fingerprint is returned as `unchanged` only after every recorded path, mode, owner, rendered non-secret file, and secret-file format still matches; drift is a conflict. There is no force-overwrite path.

Setup rollback removes only paths recorded in the journal and removes the DSH profile package only when this setup installed it. Service activation milestones and prior active/enabled states are journaled: rollback touches only services whose mutation was attempted, disables the owned Caddy unit if enable was attempted, and restarts or stops the named DSH service to restore its prior state. The final journal remains after a failed setup when its directory is still available, so recovery evidence survives.

Uninstall stops and disables the owned Caddy unit, then removes the owned profile package and recorded files. It restores captured unit files when an activation step fails. It never inspects, reloads, stops, or uninstalls a user Nginx or Caddy service.

Password reset validates the completed system ownership record, authentication-state file type, exact path, owner, group, mode, and current secret formats before reading the new password. It hashes the new password and creates a replacement session secret before either managed file changes. An inactive DSH service remains inactive; an active service is stopped, credentials are replaced, and the service is started. Start failure restores both prior files and the prior active state.

schema v1 ownership records are diagnosed and refused. Setup, doctor, reset-password, and uninstall never migrate, overwrite, or automatically uninstall v1.

## Ownership and managed paths

System setup owns only these exact paths:

| Path | Mode | Owner purpose |
|---|---:|---|
| `/etc/dsh-auth` | `0750` | root-owned configuration directory, service group readable |
| `/etc/dsh-auth/install-state.json` | `0600` | root-only v2 ownership and recovery record; no secrets |
| `/etc/dsh-auth.installing.json` | `0600` | temporary adjacent bootstrap journal, atomically moved into the configuration directory |
| `/etc/dsh-auth/dsh-auth.env` | `0640` | root/service-group environment with secret-file paths |
| `/etc/dsh-auth/session-secret` | `0640` | random signing secret, root/service-group readable |
| `/etc/dsh-auth/Caddyfile` | `0644` | project-owned Caddy config with Admin API off |
| `/usr/lib/dsh-auth` | `0755` | directory that holds the verified Caddy binary |
| `/usr/lib/dsh-auth/caddy` | `0755` | checksum-verified Caddy `v2.11.4` from the platform package |
| `/etc/systemd/system/dsh-auth-caddy.service` | `0644` | independent DynamicUser edge unit |
| `/var/lib/dsh-auth-caddy` | systemd | automatic TLS and Caddy runtime state |
| `/var/lib/dsh-auth` | `0700` | service-owned authentication state root |
| `/var/lib/dsh-auth/auth-state.json` | `0600` | administrator Argon2id and sessions |
| `/var/lib/dsh-auth/login-tokens` | `0700` | digest token files; created even when token issue is disabled |
| `/etc/systemd/system/<unit>.d/50-dsh-auth.conf` | `0644` | project-owned `EnvironmentFile` drop-in |

Existing target files without a valid state record are conflicts. Existing DSH profile installations of `dsh-auth` are also conflicts because setup cannot claim ownership retroactively. Directories shared with systemd are removed only when setup created them and they are empty.

The state parser validates mode, root ownership under `/etc`, schema v2 fields, exact fixed system/output paths, safe service/profile inputs, executable paths, and that `createdPaths` is a duplicate-free subset of the derived managed paths before any deletion or command execution. System doctor and uninstall reject output-mode records.

## Security boundaries

- Root actions use argv arrays only. User-controlled values never enter a shell string.
- Systemd service names, profile names, absolute paths, upstreams, listen addresses, domains, and certificate paths are validated before discovery or rendering.
- A root DSH service executable, DSH_HOME, existing profile tree, and every resolved parent must be root-owned and not group/world-writable. Setup does not load root-service code from a user-writable checkout or plugin tree.
- HTTPS requires an explicit server name. Automatic TLS rejects certificate parameters; manual TLS requires both certificate and key, exposed to Caddy only through systemd credentials. HTTP requires an explicit private/loopback literal address and disables secure cookies and HSTS.
- Plans contain secret file targets and descriptions, never password, hash, session-secret, or login-token values. JSON and subprocess failures withhold command output.
- Password files must be regular, bounded, and inaccessible to group/others before setup can execute. Plaintext from any accepted source is read and hashed before the first journal, package, file, or service mutation, and is never persisted by the installer. Administrator passwords must be 15–128 Unicode code points and at most 1024 UTF-8 bytes.
- Non-interactive password reset requires `--authorize-password-reset`; both setup and reset reject inline password arguments and keep secrets out of JSON and diagnostics.
- Caddy activation always follows a successful `caddy validate`. Port conflicts fail closed without stopping or taking over the occupying service.

## Caddy platform packages

Caddy is the only public listener. The installer never downloads a binary and never probes, reloads, or reuses a system Caddy or Nginx. It resolves one exact optional platform package from `process.platform` and `process.arch`:

- `dsh-auth-caddy-linux-x64@2.11.4-dsh.1`
- `dsh-auth-caddy-linux-arm64@2.11.4-dsh.1`

Each package must contain the unmodified official Caddy binary, `package.json` with that name and version, `manifest.json` plus `manifest.sha256`, `LICENSE`, and `THIRD_PARTY.md`. Setup verifies package version, manifest checksum, binary SHA-256, and license files, then copies the binary to the managed path. Missing packages, unsupported platforms, version drift, checksum mismatch, or missing licenses are prerequisite failures.

## Change map

- CLI flags, prompts, JSON, exit codes, secret-source selection: `src/cli.ts`, `src/installer/cli-parser.ts`, `tests/installer-cli.spec.ts`.
- Types and errors: `src/installer/types.ts`, `src/installer/errors.ts`.
- Root subprocess/filesystem adapter: `src/installer/host.ts`.
- Argument and root-path validation: `src/installer/validation.ts`.
- One-time login token store shared by the CLI issuer and redemption: `src/login-token-store.ts`, `tests/login-token-store.spec.ts`.
- Systemd and container issue-input resolution: `src/installer/issue-login-token.ts`, `tests/installer-cli.spec.ts`.
- Caddy rendering, platform-package verification, TLS, and ports: `src/installer/caddy.ts`, `tests/caddy-installer.spec.ts`, `scripts/check-caddy.mjs`.
- OS, systemd, and DSH service discovery: `src/installer/discovery.ts`.
- Fingerprints, plans, conflicts, state parsing: `src/installer/config-files.ts`, `src/installer/plan.ts`.
- Setup transaction and rollback: `src/installer/executor.ts`.
- Password reset validation, credential rotation, session revocation, and rollback: `src/installer/reset-password.ts`.
- Health and owned removal: `src/installer/doctor.ts`, `src/installer/uninstall.ts`.
- System behavior matrix: `tests/installer-system.spec.ts`.

## Verification and release

Installer changes require observable tests for the affected success, refusal, and rollback paths. At minimum run the repository `check`, isolated `check:caddy`, `npm pack --dry-run`, `scripts/pack-smoke.mjs`, and `scripts/installer-e2e.mjs` against the produced tarball. The installer E2E drives the packed bin through both non-interactive JSON/stdin and an actual interactive PTY. Before push, scan tracked files and Git metadata, run gitleaks, and inspect the tarball file list. Do not test against a live host edge service or bind a deployed public port; disposable output directories and isolated Caddy runtimes are sufficient.
