# Changelog

## Unreleased

Enterprise v2: bundled Caddy edge, unified administrator authentication state, and one-time login tokens.

### Changes

- Replaced the host Nginx dependency with a project-owned Caddy `v2.11.4` edge from exact linux-x64 and linux-arm64 optional packages.
- Replaced v1 identity environment variables with a service-owned `authStateFile` document and an explicit `password` or `login-token` setup choice.
- Added `issue-login-token`, fragment redemption, and first-time administrator setup. Old flags, ownership records, and sessions are not migrated.
- Token redemption accepts Chrome's `Origin: null` after `history.replaceState` when the signed CSRF cookie is valid and `Sec-Fetch-Site` is same-origin, none, or absent. Password login and logout stay on exact same-origin checks.

## v0.1.13

Initial tagged release.

### Changes

- Added the secure one-command installer, managed password reset, session persistence, and renewal.
- Added end-to-end coverage for installer, Nginx, browser, and authentication behavior.
- Added explicit npm Trusted Publishing through GitHub Actions with provenance.
