# Installer architecture

Read this document before changing `setup`, `plan`, `doctor`, `reset-password`, `uninstall`, Nginx discovery/rendering, systemd integration, package-manager support, managed paths, JSON output, or installer exit codes.

## Public surface

`setup` and `plan` accept the same validated `SetupRequest`. Interactive input and non-interactive flags only construct that request; both call `discoverHost()` and `prepareSetup()`. `setup --dry-run` selects the `plan` path before preparation. Secret input is represented by a `PasswordSource` descriptor and is read only by `executeSetup()` after all prerequisite and interactive confirmations pass.

`doctor` is read-only. `reset-password` reads the same validated ownership record, replaces only the two managed credential files, rotates the session secret to revoke sessions, and restores both files if an active DSH service cannot restart. `uninstall` reads the state record and removes only recorded files and the profile package installed by the recorded setup. The legacy `hash` and `secret` commands remain narrow credential helpers; they are not part of installation planning.

CLI command names, flag names, `--name value` or `--name=value` syntax, JSON schema version 1, and exit codes are public automation interfaces. Global flags may precede the command. `--json` is output format only and does not disable prompts. JSON documents include the command, status, exit code, redacted actions, and structured diagnostics. New flags and diagnostic codes may be added. Renaming, removing, or changing the meaning of an existing flag, JSON field, or exit code requires an explicit compatibility decision.

## State machine

```text
request -> validate -> discover -> blocked | ready | unchanged
                                      |
                                      v
                       journal(status=installing)
                                      |
                         package/profile changes
                                      |
                       permissioned file writes
                                      |
                    systemd reload -> nginx -t
                                      |
                       DSH restart -> Nginx reload
                                      |
                         state(status=installed)
```

The first managed file is the adjacent root-only bootstrap journal `/etc/dsh-auth.installing.json` with `status: installing`. Setup creates and secures the configuration directory, then atomically renames that journal to `/etc/dsh-auth/install-state.json`; a retry recognizes either location. Every later file, directory, Nginx package attempt, DSH profile package action, and service activation attempt is recorded before that mutation starts, so recovery can reconcile a crash between external changes. A retry with the same fingerprint first rolls back this journal and carries forward whether Nginx was installed. A completed identical fingerprint is returned as `unchanged` only after every recorded path, mode, owner, rendered non-secret file, and secret-file format still matches; drift is a conflict. There is no force-overwrite path.

Setup rollback removes only paths recorded in the journal and removes the DSH profile package only when this setup installed it. Service activation milestones and prior active/enabled states are journaled: rollback touches only services whose mutation was attempted, reloads or stops Nginx to restore its prior state, and restarts or stops the named DSH service to restore its prior state. The final journal remains after a failed setup when its directory is still available, so recovery evidence survives.

Uninstall removes public Nginx routing first, validates and reloads Nginx, then removes the owned profile package and systemd drop-in. It restores captured owned files and the package when an activation step fails. It never invokes a package-manager removal command for Nginx.

Password reset validates the completed system ownership record, credential file type, exact path, owner, group, mode, and current secret formats before reading the new password. It hashes the new password and creates a replacement session secret before either managed file changes. Both replacements preserve `root:<service-group>` ownership and `0640` mode. An inactive DSH service remains inactive; an active service is restarted, and restart failure restores both prior credentials before retrying the restart.

## Ownership and managed paths

System setup owns only these exact paths:

| Path | Mode | Owner purpose |
|---|---:|---|
| `/etc/dsh-auth` | `0750` | root-owned configuration directory, service group readable |
| `/etc/dsh-auth/install-state.json` | `0600` | root-only ownership and recovery record; no secrets |
| `/etc/dsh-auth.installing.json` | `0600` | temporary adjacent bootstrap journal, atomically moved into the configuration directory |
| `/etc/dsh-auth/dsh-auth.env` | `0640` | root/service-group environment with secret-file paths |
| `/etc/dsh-auth/password-hash` | `0640` | Argon2id hash, root/service-group readable |
| `/etc/dsh-auth/session-secret` | `0640` | random signing secret, root/service-group readable |
| `/var/lib/dsh-auth` | `0700` | service-owned session state directory |
| `/etc/systemd/system/<unit>.d/50-dsh-auth.conf` | `0644` | project-owned `EnvironmentFile` drop-in |
| discovered `conf.d` or `sites-enabled` `dsh-auth.conf` | `0644` | project-owned Nginx include |

Existing target files without a valid state record are conflicts. Existing DSH profile installations of `dsh-auth` are also conflicts because setup cannot claim ownership retroactively. Directories shared with systemd or Nginx are removed only when setup created them and they are empty.

The state parser validates mode, root ownership under `/etc`, schema fields, exact fixed system/output paths, exact `nginx.service`, safe service/profile inputs, executable paths, and that `createdPaths` is a duplicate-free subset of the derived managed paths before any deletion or command execution. System doctor and uninstall reject output-mode records.

## Security boundaries

- Root actions use argv arrays only. User-controlled values never enter a shell string.
- Systemd service names, profile names, absolute paths, upstreams, listen addresses, domains, and certificate paths are validated before discovery or rendering.
- A root DSH service executable, DSH_HOME, existing profile tree, and every resolved parent must be root-owned and not group/world-writable. Setup does not load root-service code from a user-writable checkout or plugin tree.
- HTTPS requires an explicit server name, certificate, and key. HTTP requires an explicit private/loopback literal address and disables secure cookies and HSTS.
- Plans contain secret file targets and descriptions, never password, hash, or session-secret values. JSON and subprocess failures withhold command output.
- Password files must be regular, bounded, and inaccessible to group/others before setup can execute. Plaintext from any accepted source is read and hashed before the first journal, package, file, or service mutation, and is never persisted by the installer.
- Non-interactive password reset requires `--authorize-password-reset`; both setup and reset reject inline password arguments and keep secrets out of JSON and diagnostics.
- Nginx activation always follows a successful `nginx -t`. A reload failure rolls back the candidate include and validates the restored configuration before reloading.

## Nginx and package discovery

Discovery checks fixed executable locations, parses `nginx -V` for version, `--with-http_auth_request_module`, and `--conf-path`, then tokenizes active main-config directives and accepts only an include directly inside the top-level `http` block ending in `conf.d/*.conf` or `sites-enabled/*`. Commented and stream/server-context includes do not qualify. System activation requires `nginx.service` with `LoadState=loaded` under systemd.

Automatic package installation is a closed table. The verified Ubuntu 24.04 baseline uses `/usr/bin/apt-get update` followed by `/usr/bin/apt-get install --yes nginx`. The installer re-runs full Nginx discovery after the command. A package that is too old, omits `auth_request`, lacks the supported include, or lacks systemd remains installed for operator inspection, while protected deployment stays inactive. Add another distribution only with a real isolated package-install smoke and fixed argv tests.

## Change map

- CLI flags, prompts, JSON, exit codes, secret-source selection: `src/cli.ts`, `tests/installer-cli.spec.ts`.
- Types and errors: `src/installer/types.ts`, `src/installer/errors.ts`.
- Root subprocess/filesystem adapter: `src/installer/host.ts`.
- Argument and root-path validation: `src/installer/validation.ts`.
- Nginx rendering and discovery: `src/installer/nginx.ts`, `tests/nginx-installer.spec.ts`, `scripts/check-nginx.mjs`.
- OS, systemd, DSH service, and package-manager discovery: `src/installer/discovery.ts`.
- Fingerprints, plans, conflicts, state parsing: `src/installer/config-files.ts`, `src/installer/plan.ts`.
- Setup transaction and rollback: `src/installer/executor.ts`.
- Password reset validation, credential rotation, session revocation, and rollback: `src/installer/reset-password.ts`.
- Health and owned removal: `src/installer/doctor.ts`, `src/installer/uninstall.ts`.
- System behavior matrix: `tests/installer-system.spec.ts`.

## Verification and release

Installer changes require observable tests for the affected success, refusal, and rollback paths. At minimum run the repository `check`, isolated `check:nginx`, `npm pack --dry-run`, `scripts/pack-smoke.mjs`, and `scripts/installer-e2e.mjs` against the produced tarball. The installer E2E drives the packed bin through both non-interactive JSON/stdin and an actual interactive PTY. Before push, scan tracked files and Git metadata, run gitleaks, and inspect the tarball file list. Do not test against the active host Nginx include, reload its service, or bind its deployed port; disposable output directories and Nginx prefixes are sufficient.
