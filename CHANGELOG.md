# Changelog

## v0.2.0

Changes since [v0.1.15](https://github.com/hxy91819/dsh-auth/compare/v0.1.15...v0.2.0).

### Breaking changes

- release!: require v1 uninstall before 0.2.0 setup (`fd1741a`). Thanks masonxhuang.

### Changes

- docs: derive token-login progress from execution cards ([#14](https://github.com/hxy91819/dsh-auth/pull/14)). Thanks @hxy91819.
- feat: reset the administrator password from Settings ([#13](https://github.com/hxy91819/dsh-auth/pull/13)). Thanks @hxy91819.
- docs: require every PR review comment to be adopted or rejected before land (`109a099`). Thanks masonxhuang.
- ci: run Actions once per PR and cancel superseded runs (`80f2061`). Thanks masonxhuang.
- fix: restore exact token Origin checks and cross-process issue capacity ([#9](https://github.com/hxy91819/dsh-auth/pull/9)). Thanks @hxy91819.
- docs: require autoreview and green CI before landing a PR ([#12](https://github.com/hxy91819/dsh-auth/pull/12)). Thanks @hxy91819.
- docs: document custom login-token failure messages ([#11](https://github.com/hxy91819/dsh-auth/pull/11)). Thanks @hxy91819.
- fix: fail closed on unsafe login-token directories and files ([#10](https://github.com/hxy91819/dsh-auth/pull/10)). Thanks @hxy91819.
- docs: close the one-time token login epic after 0.1.15 ([#8](https://github.com/hxy91819/dsh-auth/pull/8)). Thanks @hxy91819.
- docs: mark the token-login epic complete in the topic README (`0aa1e61`). Thanks masonxhuang.
- docs: close STORY-06 after publishing dsh-auth 0.1.15 (`04c717b`). Thanks masonxhuang.
- fix: vendor Caddy before ignore-scripts release pack (`30ab723`). Thanks masonxhuang.

### Contributors

Thanks masonxhuang and @hxy91819 for this release.

## v0.1.15

Changes since [v0.1.14](https://github.com/hxy91819/dsh-auth/compare/v0.1.14...v0.1.15).

### Changes

- docs: record live systemd acceptance for bundled Caddy 0.1.15 (`7381c4a`). Thanks masonxhuang.
- merge: incorporate main Caddy self-contained docs contract (`d499c2a`). Thanks masonxhuang.
- fix: start DynamicUser Caddy without a root-owned state directory (`4f5c39d`). Thanks masonxhuang.
- feat: ship official Caddy binaries inside the dsh-auth tarball (`92e5234`). Thanks masonxhuang.

### Contributors

Thanks masonxhuang for this release.

## v0.1.14

Changes since [v0.1.13](https://github.com/hxy91819/dsh-auth/compare/v0.1.13...v0.1.14).

### Changes

- release: prepare v0.1.14 (`0e5919f`). Thanks masonxhuang.
- fix: keep published lib files and Chrome token redemption working (`82bd485`). Thanks masonxhuang.
- docs: record the next multi-account collaboration direction (`4b26ad2`). Thanks masonxhuang.
- chore: ignore node_modules when it is a worktree symlink (`43ed0ca`). Thanks masonxhuang.
- feat: let the first token login set administrator credentials (`047e017`). Thanks masonxhuang.
- chore: apply advisory code-health policy to long test suites (`c335111`). Thanks masonxhuang.
- feat: redeem one-time login tokens through a fragment bridge (`92796d1`). Thanks masonxhuang.
- feat: issue one-time login tokens from system and container states (`f5d8bf8`). Thanks masonxhuang.
- feat: switch installer to enterprise v2 Caddy contract (`c707512`). Thanks masonxhuang.
- docs: complete Caddy spike and plan parallel work (`4a0fe68`). Thanks masonxhuang.
- feat: validate embedded Caddy edge runtime (`09b00ba`). Thanks masonxhuang.
- docs: complete unified auth state story (`88ca83e`). Thanks masonxhuang.
- feat: unify administrator authentication state (`46721cb`). Thanks masonxhuang.
- docs: add Caddy to token login epic (`5bb2c21`). Thanks masonxhuang.
- chore: refresh Harness baseline to rc.7 (`0c30e11`). Thanks masonxhuang.
- docs: plan one-time token login v2 (`9905804`). Thanks masonxhuang.
- feat: stabilize installer CLI contract (`6f9f637`). Thanks masonxhuang.
- merge: code health governance (`9885c18`). Thanks masonxhuang.
- docs: install the CLI globally and document required flags ([#7](https://github.com/hxy91819/dsh-auth/pull/7)). Thanks @hxy91819.
- Merge remote-tracking branch 'origin/main' (`7563fb9`). Thanks masonxhuang.
- ci: publish verified GitHub releases (`97ba5f7`). Thanks masonxhuang.
- ci: add continuous security scans (`595906f`). Thanks masonxhuang.
- ci: harden npm 12 release validation (`f089720`). Thanks masonxhuang.
- ci: enable Dependabot updates (`842f452`). Thanks masonxhuang.
- merge: integrate authentication security audit (`e612bf0`). Thanks masonxhuang.
- docs: add npm release runbook (`513c8f4`). Thanks masonxhuang.
- test: enforce authentication end-to-end coverage (`6b64ba9`). Thanks masonxhuang.
- fix: publish local release tarball (`97deb40`). Thanks masonxhuang.

### Contributors

Thanks masonxhuang and @hxy91819 for this release.

## v0.1.13

Initial tagged release.

### Changes

- Added the secure one-command installer, managed password reset, session persistence, and renewal.
- Added end-to-end coverage for installer, Nginx, browser, and authentication behavior.
- Added explicit npm Trusted Publishing through GitHub Actions with provenance.
