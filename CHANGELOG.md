# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Fixed
- Documentation-only: the Configuration sections of both READMEs described a config carrier that does not exist in code (zh claimed a top-level `dsh-llm-net-retry:` section in settings.yaml "same mechanism as other plugins"; en claimed a `plugins: dsh-llm-net-retry:` nesting — the two contradicted each other). Both now document the real carrier: the composition entry config, set via the `config:` block of the mount entry in the patch layer (same form dsh-llm-stats documents). No code change; no release.

## [0.3.1] - 2026-09-05

### Changed
- Clean-uninstall documentation + an uninstall leg in the boot smoke asserting removal reconciles the profile tree back to stock: a README (zh/en) Uninstall section (`dsh plugin --profile <profile> remove @aiwayds/dsh-llm-net-retry` — the host splices the bundles entry and drops the patch layer; the plugin keeps zero on-disk state, historical `llm/retry` events in old session logs are benign host data), cross-referencing the Compatibility section's clean-removal claim
