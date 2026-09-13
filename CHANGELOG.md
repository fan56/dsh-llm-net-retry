# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

(none)

## [0.5.0] - 2026-09-13

### Added
- **Three new leak wordings matched** (gateway-echoed upstream error texts reported in upstream discussions #4361 comment 18418461 and #3158; all land as non-retryable `PI_AI_ERROR` on dsh 0.1.5-rc.2):
  - `unexpected EOF` — a response body cut short mid-stream (Go `io.ErrUnexpectedEOF`, Node's `HPE_UNEXPECTED_EOF…` parser variant, zlib's truncated-gunzip `unexpected end of file`).
  - `remote error: tls: bad record MAC` — a fatal TLS alert from the remote side (Go rendering); the `remote error: tls:` prefix family is matched.
  - `stream_read_error` — gateway-normalized mid-stream read failure (#3158), in `_`/space/`-` spellings.
- **Code guard**: the net now claims a failure only when its code sits outside the stock taxonomy — the stock policy's default retryable set (`EMPTY_RESPONSE`/`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`), permanent failures (`AUTH`, `INVALID_CREDENTIAL`, `INVALID_REQUEST`, `CONTEXT_WINDOW_EXCEEDED`, `QUOTA`) and caller aborts (`ABORTED`) are declined even on a message match. Everything else (the `PI_AI_ERROR` catch-all, DeepSeek unknown-reason codes, raw-throw `UNKNOWN`, oddball `HTTP_<status>` codes) falls through to the message patterns. This mechanizes the "only leaked spellings" charter and makes the net stand down automatically if upstream ever reclassifies a wording (e.g. as `TRANSPORT`) — no second retry budget is stacked behind the stock policy's decision to stop.
- `isLeakedNetworkFailure(message, code)` now takes the failure code (was message-only); a message that matches without an out-of-taxonomy code no longer triggers the net.

### Documentation
- Both READMEs document the widened matcher families and the code guard; the Configuration sections fixed the config-carrier description (the composition entry `config:` block in the patch layer, not a settings.yaml section — zh and en previously contradicted each other).

## [0.4.0] - 2026-09-11

### Changed
- dsh closure 升至 0.1.5-rc.2（dev pins、locks、peer floor、README support floor；rc.2 无 API/协议变化，纯依赖跟进）。
- **dsh closure moved to 0.1.5-rc.1** (dev pins, locks).
- **CI tests run with `--test-force-exit`** so a failing test's unclosed gateway server can no longer hang the Test step; the e2e harness drops its redundant SessionProjections plugin (the 0.1.5 testkit mounts it) and awaits the now-async `agentLoop.create()`.


## [0.3.1] - 2026-09-05

### Changed
- Clean-uninstall documentation + an uninstall leg in the boot smoke asserting removal reconciles the profile tree back to stock: a README (zh/en) Uninstall section (`dsh plugin --profile <profile> remove @aiwayds/dsh-llm-net-retry` — the host splices the bundles entry and drops the patch layer; the plugin keeps zero on-disk state, historical `llm/retry` events in old session logs are benign host data), cross-referencing the Compatibility section's clean-removal claim
