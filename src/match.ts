/**
 * Matcher for network failures that reach the request-error waterfall with a
 * message the stock classification cannot recognize.
 *
 * Two producers are known today, both from OpenAI-compatible gateways:
 *
 * - pi-ai (`openai-completions`) maps an unrecognized wire `finish_reason` to
 *   `stopReason: 'error'` with the verbatim message
 *   `Provider finish_reason: network_error`; dsh's stock classifier's
 *   `\bnetwork\b` cannot see the underscore spelling (underscore is a word
 *   character), so the failure lands as non-retryable `PI_AI_ERROR`.
 * - the DeepSeek adapter maps unknown finish reasons to
 *   `model stopped: network_error` with code `NETWORK_ERROR`, also outside the
 *   default retryable codes.
 *
 * Variants already classified as TRANSPORT (ECONNRESET, "other side closed",
 * "terminated", stream truncation, timeouts, HTTP 5xx) are retried by the
 * stock policy and deliberately NOT matched here — this module only names the
 * leaked spellings.
 *
 * ## Adjudication: RemoteError cannot reach this waterfall (dsh 0.1.2-alpha.3)
 *
 * The Remote gateway's `RemoteError` (dsh-typert-protocol, `isDSHRemoteError`
 * marker + `code`) is structurally UNREACHABLE from `'agent/request-error'`,
 * so this module intentionally has NO structured RemoteError branch. Evidence
 * from the alpha.3 closure:
 *
 * 1. The waterfall has exactly one emit point: dsh-agent-loop
 *    (`lib/index.js:660`), whose `payload.failure` is always `finish.failure`
 *    from the BlockAssembler consuming the process-local `llm.stream()`
 *    chunk stream.
 * 2. Every error escaping adapter dispatch/iteration is flattened by dsh-llm's
 *    `normalizeLlmFailure` (`lib/index.js:367`, called from
 *    `adapterFailureChunk` at `lib/index.js:1744`) into a frozen plain
 *    `{ message, code, ... }` — no `isDSHRemoteError` marker survives, and
 *    `harnessErrorCode` (`lib/index.js:434`) trusts only HarnessError codes, so
 *    even a stray RemoteError degrades to `code: 'UNKNOWN'`. Adapters that
 *    build failures directly (dsh-llm-pi-ai `lib/index.js:1306-1338`) produce
 *    the same plain shape.
 * 3. The Remote/LLM intersection is control-plane only: dsh-llm's generated
 *    Remote face (`lib/typert.remote-client.js`) exposes discoverModels /
 *    listProviders — never `stream` — and the sole `new RemoteError` in
 *    dsh-llm is `remoteDiscoverModels` (`lib/index.js:1429-1437`, code
 *    `llm/model-discovery-rejected`), consumed across the client-host gateway
 *    boundary, outside any request attempt.
 * 4. Errors that bypass normalization (middleware, cleanup) are rethrown by
 *    the stream consumer and land in the loop's turn-level catch
 *    (dsh-agent-loop `lib/index.js:574-585`), which appends `turn/end` and
 *    rethrows — it never reaches the request-error waterfall.
 *
 * If a future dsh line routes LLM traffic through the Remote carrier, revisit
 * this: the structured check would be `failure` as a RemoteError with a
 * network-class `code`.
 */

/** `network_error` / `network-error` / `network error`, case-insensitive. */
const NETWORK_ERROR = /network[-_ ]error/i

/** pi-ai's rendering of any gateway stop reason it does not recognize. */
const PROVIDER_FINISH_REASON = /provider finish_reason:/i

/**
 * Whether a failure message names a network failure the stock retry policy
 * could not classify.
 * @param message - the LLM failure message.
 * @returns true when the message is a leaked network-error variant.
 */
export function isLeakedNetworkFailure(message: string): boolean {
  return NETWORK_ERROR.test(message) || PROVIDER_FINISH_REASON.test(message)
}
