# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Fixed
- **`ACCOUNT_QUOTA` joins the never-claim blocklist.** dsh 0.1.7-rc.2 added the canonical account-quota code (`ACCOUNT_QUOTA_EXCEEDED_CODE` in `dsh-llm/error.d.ts` — account-token quota rechargeable through the first-party billing page, the same permanent no-retry family as `QUOTA`). Fixture-tested alongside the `QUOTA` control (audited at tag `dsh-v0.1.7-rc.2`).

## [0.6.0] - 2026-09-24

### Changed
- **dsh closure moved to 0.1.7-rc.1** (dev pins exact `0.1.7-rc.1`, peer floor `>=0.1.7-rc.1`). The official DeepSeek adapter is Messages API-only in this line (Chat Completions and the `protocol` option removed); error-text sources on the Messages wire were re-verified against the official `llm-deepseek` sources at tag `dsh-v0.1.7-rc.1`.
- Shared closure pins lifted to what the 0.1.7-rc.1 packages declare: `@deepseek-ai/cordis` `4.0.2` → `4.0.4` (peer `~4.0.4` across the whole dsh closure) and `@deepseek-ai/schemastery` `3.18.2` → `3.18.4` (dsh-llm depends on `~3.18.4`); `package-lock.json` regenerated against the new graph (npm's lock-only builder chokes on `agent-base`'s stray `tsconfig@0.0.0` devDep — generated from a real install; day-to-day install tool is pnpm, `pnpm-lock.yaml` added).
- All four existing patterns still hit on the 0.1.7 wire: `network[-_ ]error`, `provider finish_reason:` (pi-ai remains multi-protocol; the wording is intact in `@earendil-works/pi-ai` `openai-completions`, re-proven by the e2e suite), `unexpected EOF`/TLS/`stream_read_error` (gateway echoes still reach the classifier bare with out-of-taxonomy codes).

### Added
- **Two Messages-wire patterns** (fixtures sampled from the official adapter's error construction; matcher signature `(message, code)` and the blocklist guard semantics unchanged — the net still stands down automatically when upstream classifies a code `TRANSPORT` etc.):
  - `unsupported stop reason` — `DeepSeek Messages stream: unsupported stop reason <reason>` (`MALFORMED_RESPONSE`, `translate.ts` `stopReason()`), the Messages successor of the `provider finish_reason:` face; `network_error` spellings were already covered, every other reason is claimed now.
  - `stream ended (?:before|without)\b` — the early-stream-end family: `DeepSeek Messages stream ended before message_stop` and pi-ai's `pi-ai event stream ended without done/error` (both `STREAM_CLOSED`). A clean SSE close is not a read error, so the adapter's `TRANSPORT` wrap never sees it; same wording rule pi-ai upstream uses to classify its own provider truncation texts `TRANSPORT` — the code guard splits them, only unclassified `STREAM_CLOSED` spills are claimed.
- Fixture tests for the Messages wire, including negative controls: read-path wraps (`DeepSeek Messages transport failed` → `TRANSPORT`), in-band SSE error events (always classify into blocked codes), idle timeout, empty settlements, and protocol-corruption wordings stay with the stock policy.
- **Plugin Manager metadata.** Added `icon.svg` and `locale/{en,zh}.json` (`meta.title`/`meta.description` per the official `readPluginMeta` contract); `package.json` now declares the `icon` and ships both in the tarball.

### Documentation
- Both READMEs document the 0.1.7 Messages-wire error surface (what changed, what the plugin now claims, what it hands to the stock policy) and raise the support floor to `>=0.1.7-rc.1`; `src/match.ts` documents the audited Messages-path evidence.
- `snapshotEvents` at the retry-counting read (src/index.ts) is kept per the official soft-deprecation contract ("existing logic may remain unmigrated") — the registered-projection successor only interprets message-producing events (our `llm/retry` records are non-surface) and the persistence `handle.read()` pagination is a structural rewrite, not a drop-in. Annotated at the call site.

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
