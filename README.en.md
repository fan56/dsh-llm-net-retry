# dsh-llm-net-retry

[中文](README.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh)
plugin that retries transient model-request failures OpenAI-compatible gateways
report in non-standard wordings — failures the stock retry policy cannot
classify and therefore lets hard-fail the whole turn.

## Why

Some gateways (e.g. [OpenCode Zen](https://opencode.ai/zen)) relay their own
upstream connection failure to the client (as the stream's terminal
`finish_reason`, echoed error payloads, …) instead of an HTTP/transport error.
On dsh `0.1.5-rc.2` (the rc/stable line this plugin tracked before the 0.1.7
migration; same on the 0.1.7 Messages line, see the next section) those
wordings are still mis-classified:

| Path | Failure produced | Stock classification |
|---|---|---|
| `llm-pi-ai` (`openai-completions`) | `Provider finish_reason: network_error` | `PI_AI_ERROR` — not retryable |
| `llm-deepseek` | `model stopped: network_error`, code `NETWORK_ERROR` | not retryable |
| `llm-pi-ai` (gateway-echoed upstream error text, [#4361](https://github.com/deepseek-ai/deepseek-harness/discussions/4361)) | `unexpected EOF` / `remote error: tls: bad record MAC` | `PI_AI_ERROR` — not retryable |
| `llm-pi-ai` ([#3158](https://github.com/deepseek-ai/deepseek-harness/discussions/3158)) | `stream_read_error` | `PI_AI_ERROR` — not retryable |

`dsh-llm-retry` only retries codes in the provider's `retryableCodes`
(`TRANSPORT`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `EMPTY_RESPONSE`), so nobody
retries and the turn — including subagent turns — fails outright. Retrying
immediately almost always succeeds; these are transient gateway-side drops.

**Since dsh `0.1.7`** the official DeepSeek adapter is Messages API-only (Chat
Completions and the `protocol` option are gone; anthropic-style `/messages`
SSE), which moves the error-text sources (verified against the
`llm-deepseek` sources at tag `dsh-v0.1.7-rc.1`):

| Path (0.1.7 Messages wire) | Failure produced | Stock classification | This plugin |
|---|---|---|---|
| Unknown `stop_reason` (`translate.ts` `stopReason()`) | `DeepSeek Messages stream: unsupported stop reason <reason>` | `MALFORMED_RESPONSE` — not retryable | claimed (`network_error` spellings via the network pattern, every other reason via the `unsupported stop reason` pattern) |
| Stream ends cleanly before `message_stop` (gateway half-close, proxy failover) | `DeepSeek Messages stream ended before message_stop` (pi-ai wire: `pi-ai event stream ended without done/error`) | `STREAM_CLOSED` — not retryable | claimed |
| Read-path throws (fetch rejects, body read errors, TLS, undici truncation) | `DeepSeek Messages transport failed` | `TRANSPORT` — retryable | stands down (stock policy owns it) |
| In-band SSE `error` events (`providerError`) | gateway-echoed text | always lands in the retryable set (`SERVER` etc.) | stands down |

I.e. most of the old EOF/TLS/stream-read wordings now degrade to `TRANSPORT`
and the stock policy takes over — exactly the code guard's standing contract.
The genuinely new blind-spot faces are `MALFORMED_RESPONSE` /
`STREAM_CLOSED`.

opencode fixed the same behavior upstream in
[40282c1](https://github.com/anomalyco/opencode/commit/40282c1d4d5476e6b536a72c0baf3a27bcf0e4df)
and
[e0b9e68](https://github.com/anomalyco/opencode/commit/e0b9e68a68a8bc8367d84e305efd114d0445348a).

A fix for the dsh base is prepared on
[`fix/network-error-retryable`](https://github.com/fan56/deepseek-harness/tree/fix/network-error-retryable)
(fork; dsh does not accept external PRs at the moment — reported in
Discussions). The same failure family keeps receiving new upstream reports
since ([#3158](https://github.com/deepseek-ai/deepseek-harness/discussions/3158),
[#4361](https://github.com/deepseek-ai/deepseek-harness/discussions/4361) and its
2026-09-13 follow-up) with no fix landed. Until it ships, this plugin is the
remedy, and it stays harmless afterwards: it only acts when the whole
`agent/request-error` waterfall has declined AND the failure sits outside the
stock taxonomy, and it never touches llm-retry's own retry counting.

## How it works

The plugin listens at the **end** of the `agent/request-error` waterfall:

1. Call `next()` first — the provider's policy executors (`dsh-llm-retry`)
   decide. If any of them retries, that decision passes through unchanged.
2. Only when every listener declined and the failure sits in the stock
   classifier's blind spot (message AND code, see below) schedule this
   plugin's own bounded retry. Message-side coverage: `network_error` /
   `network-error` / `network error`; pi-ai's `Provider finish_reason:`
   rendering of an unrecognized gateway stop reason; the Messages wire's
   `unsupported stop reason` (since `0.1.7`, llm-deepseek's rendering of an
   unknown anthropic `stop_reason`); the gateway-echoed
   transport wordings `unexpected EOF` (including the `HPE_UNEXPECTED_EOF…`
   and zlib `unexpected end of file` variants), `remote error: tls: bad
   record MAC`, `stream_read_error`, and the early-stream-end wordings
   `stream ended before/without …` (`STREAM_CLOSED`; same shape as pi-ai's
   own rule that classifies this family `TRANSPORT` — the code guard ensures
   only the unclassified `STREAM_CLOSED` spills reach this plugin).
3. Retries are durable and visible: `llm/retry` / `llm/retry-started` session
   events, schema-compatible with llm-retry's, so TUI surfaces render them
   unchanged. Counting uses this plugin's own policy key (`net-retry:v1…`),
   never llm-retry's.

**Code guard**: codes whose recovery the harness already owns are declined
even when the message matches — the stock policy's default retryable set
(`EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`) belongs
to the stock policy (including its decision to stop retrying), and permanent
failures (`AUTH`, `INVALID_REQUEST`, `QUOTA`, …) or caller aborts (`ABORTED`)
cannot be fixed by a retry. Everything else — the `PI_AI_ERROR` catch-all,
DeepSeek's unknown-reason codes, raw-throw `UNKNOWN`, oddball
`HTTP_<status>` codes — falls through to the message patterns. This also
means the net stands down automatically once upstream reclassifies a wording
(e.g. as `TRANSPORT`): the stock policy takes over and no second retry budget
is stacked behind the user's back.

## Install

This is a standalone dsh plugin, independent of any host UI: install it into
**any dsh profile** (replace `<profile>` with your profile name — profiles are
created and managed by the `dsh` CLI, not tied to the TUI):

```bash
dsh plugin --profile <profile> add @aiwayds/dsh-llm-net-retry
```

The `cordis.patch.yml` in this package mounts it under the plugin id
`dsh-llm-net-retry`; it takes effect for every dsh instance started from the
profile it is installed into (TUI, web, or a custom launcher).

> ⚠️ All `@deepseek-ai/*` packages are peerDependencies (resolved from the dsh
> closure) — never install them into the plugin as regular dependencies, or
> you get a second cordis closure and cryptic crashes.

## Uninstall

```bash
dsh plugin --profile <profile> remove @aiwayds/dsh-llm-net-retry
```

The host reconciles the profile automatically: the `dsh.profile.bundles` entry is spliced out and the package's patch layer drops. The plugin keeps **zero on-disk state** — no data files, no settings namespace — so removal leaves nothing behind (see "dispose removes it cleanly" in the Compatibility section). Historical `llm/retry` events already recorded in old session logs are untouched — benign host data, not plugin state.

## Configuration

All options are optional — defaults work out of the box. The plugin uses **no
settings namespace**: configuration rides the composition entry config, i.e.
the `config:` block of the mount entry in the patch layer (the profile's
`cordis.patch.yml`):

```yaml
- insert:
    - id: dsh-llm-net-retry
      name: '@aiwayds/dsh-llm-net-retry'
      config:
        mode: on            # 'off' disables the listener entirely
        maxRetries: 5
        backoff:
          initialDelayMs: 500
          maxDelayMs: 10000
          jitterRatio: 0.1
```

Unknown keys are rejected. Defaults match llm-retry's stock policy
(5 retries, 500 ms → 10 s exponential backoff, symmetric jitter 0.1).

## Verification

- Unit tests: matcher table (positive/negative × failure codes, the code
  guard, near-miss spellings), backoff math with injected random, config
  validation, and the decision chain on a real cordis context with a real
  session store (passthrough, retry, counting, abort, mode off,
  downstream-error resilience).
- End-to-end: the real agent loop + the real `llm-pi-ai`
  `openai-completions` adapter against a scripted local gateway that answers
  the first two requests with `finish_reason: "network_error"` (plus a leg
  with the relay-echo shape `finish_reason: "unexpected EOF"`) — the turn
  completes after the retries with `llm/retry` events recorded, while the
  negative control (plugin absent) fails after exactly one request.
- Integration check: the real classifier output of the locally installed dsh
  `0.1.7-rc.1` is the baseline — every covered wording is asserted to be
  classified `PI_AI_ERROR` there and claimed by this net.

```bash
npm test        # builds first: npm run build
```

The e2e suite runs in an isolated temp `$HOME` and never touches `~/.dsh`.
Additionally validated on a real dsh 0.1.0-rc.8 `--profile tui` host
(dsh-tui-pi): the retry chain (exponential backoff, stable retryId, durable
events, TUI rendering) behaved exactly as designed.

## Compatibility

**Requires dsh >= 0.1.7-rc.1** — this plugin targets the dsh RC/stable line only (CI and releases resolve the newest of the `latest`/`next` dist-tags at runtime). **The alpha line is no longer supported.**

Targets the `agent/request-error` waterfall and `llm/retry` event schema of
dsh `>=0.1.7-rc.1` (the soft-deprecated `snapshotEvents` read remains per the
official deprecation contract). The plugin is read-only with respect to the
dsh base: no
monkey-patching, no service replacement — dispose removes it cleanly.

## License

MIT
