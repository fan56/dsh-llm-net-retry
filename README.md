# dsh-llm-net-retry

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh)
plugin that retries model-request failures OpenAI-compatible gateways report as
`finish_reason: "network_error"` — failures the stock retry policy cannot
classify and therefore lets hard-fail the whole turn.

## Why

Some gateways (e.g. [OpenCode Zen](https://opencode.ai/zen)) report their own
upstream connection failure as the stream's terminal `finish_reason` instead of
an HTTP/transport error. As of dsh `0.1.1-rc.2` both adapter paths
mis-classify it:

| Path | Failure produced | Stock classification |
|---|---|---|
| `llm-pi-ai` (`openai-completions`) | `Provider finish_reason: network_error` | `PI_AI_ERROR` — not retryable |
| `llm-deepseek` | `model stopped: network_error`, code `NETWORK_ERROR` | not retryable |

`dsh-llm-retry` only retries codes in the provider's `retryableCodes`
(`TRANSPORT`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `EMPTY_RESPONSE`), so nobody
retries and the turn — including subagent turns — fails outright. Retrying
immediately almost always succeeds; these are transient gateway-side drops.

opencode fixed the same behavior upstream in
[40282c1](https://github.com/anomalyco/opencode/commit/40282c1d4d5476e6b536a72c0baf3a27bcf0e4df)
and
[e0b9e68](https://github.com/anomalyco/opencode/commit/e0b9e68a68a8bc8367d84e305efd114d0445348a).

A fix for the dsh base is prepared on
[`fix/network-error-retryable`](https://github.com/fan56/deepseek-harness/tree/fix/network-error-retryable)
(fork; dsh does not accept external PRs at the moment — reported in
Discussions). Until it ships, this plugin is the remedy, and it stays harmless
afterwards: it only acts when the whole `agent/request-error` waterfall has
declined, and it never touches llm-retry's own retry counting.

## How it works

The plugin listens at the **end** of the `agent/request-error` waterfall:

1. Call `next()` first — the provider's policy executors (`dsh-llm-retry`)
   decide. If any of them retries, that decision passes through unchanged.
2. Only when every listener declined and the failure message names a leaked
   network variant — `network_error` / `network-error` / `network error`, or
   pi-ai's `Provider finish_reason:` rendering of an unrecognized gateway stop
   reason — schedule this plugin's own bounded retry.
3. Retries are durable and visible: `llm/retry` / `llm/retry-started` session
   events, schema-compatible with llm-retry's, so TUI surfaces render them
   unchanged. Counting uses this plugin's own policy key (`net-retry:v1…`),
   never llm-retry's.

Failures already classified as `TRANSPORT` (ECONNRESET, `terminated`,
stream truncation, timeouts, HTTP 5xx) are retried by the stock policy and are
deliberately not matched again here.

## Install

```bash
# inside a dsh profile with the plugin loader
npm install @aiwayds/dsh-llm-net-retry
```

The `cordis.patch.yml` in this package mounts it under the plugin id
`dsh-llm-net-retry`.

> ⚠️ All `@deepseek-ai/*` packages are peerDependencies (resolved from the dsh
> closure) — never install them into the plugin as regular dependencies, or
> you get a second cordis closure and cryptic crashes.

## Configuration

```yaml
plugins:
  dsh-llm-net-retry:
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

- Unit tests: matcher table (positive/negative), backoff math with injected
  random, config validation, and the decision chain on a real cordis context
  with a real session store (passthrough, retry, counting, abort, mode off,
  downstream-error resilience).
- End-to-end: the real agent loop + the real `llm-pi-ai`
  `openai-completions` adapter against a scripted local gateway that answers
  the first two requests with `finish_reason: "network_error"` — the turn
  completes on the third request with `llm/retry` events recorded, while the
  negative control (plugin absent) fails after exactly one request.

```bash
npm test        # builds first: npm run build
```

The e2e suite runs in an isolated temp `$HOME` and never touches `~/.dsh`.

## Compatibility

Targets the `agent/request-error` waterfall and `llm/retry` event schema of
dsh `0.1.1-rc.x`. The plugin is read-only with respect to the dsh base: no
monkey-patching, no service replacement — dispose removes it cleanly.

## License

MIT
