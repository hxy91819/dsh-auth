# Security policy

## Supported versions

Until the first stable release, only the latest source revision and latest released `0.x` artifact receive security fixes.

## Reporting a vulnerability

Use the repository host's private security-advisory feature once a public repository exists. Before then, contact the maintainer through a private channel agreed outside this repository. Do not open a public issue containing credentials, cookies, hashes, exploit details, private hostnames, logs, or deployment configuration.

Include the affected version, impact, minimal reproduction, and whether the issue has been disclosed elsewhere. Use synthetic accounts and redact secrets. Maintainers should acknowledge a report within seven days and coordinate remediation and disclosure timing with the reporter.

## Deployment incidents

For suspected compromise, remove public reachability, rotate the session secret to revoke every session, replace the password hash if credentials may be exposed, inspect Nginx and service logs without publishing them, and update DSH, Node, Nginx, and `dsh-auth` to fixed versions.
