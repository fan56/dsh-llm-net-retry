# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Fixed
- Documentation-only: the Configuration sections of both READMEs described a config carrier that does not exist in code (zh claimed a top-level `dsh-llm-net-retry:` section in settings.yaml "same mechanism as other plugins"; en claimed a `plugins: dsh-llm-net-retry:` nesting — the two contradicted each other). Both now document the real carrier: the composition entry config, set via the `config:` block of the mount entry in the patch layer (same form dsh-llm-stats documents). No code change; no release.

## [0.4.0] - 2026-09-11

### Changed
- dsh closure 升至 0.1.5-rc.2（dev pins、locks、peer floor、README support floor；rc.2 无 API/协议变化，纯依赖跟进）。
- **dsh closure moved to 0.1.5-rc.1** (dev pins, locks).
- **CI tests run with `--test-force-exit`** so a failing test's unclosed gateway server can no longer hang the Test step; the e2e harness drops its redundant SessionProjections plugin (the 0.1.5 testkit mounts it) and awaits the now-async `agentLoop.create()`.


## [0.3.1] - 2026-09-05

### Changed
- Clean-uninstall documentation + an uninstall leg in the boot smoke asserting removal reconciles the profile tree back to stock: a README (zh/en) Uninstall section (`dsh plugin --profile <profile> remove @aiwayds/dsh-llm-net-retry` — the host splices the bundles entry and drops the patch layer; the plugin keeps zero on-disk state, historical `llm/retry` events in old session logs are benign host data), cross-referencing the Compatibility section's clean-removal claim
