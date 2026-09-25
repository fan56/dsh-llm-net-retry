/**
 * Matcher for network failures that reach the request-error waterfall with a
 * message the stock classification cannot recognize.
 *
 * Producers known today, all OpenAI-compatible gateways relaying their own
 * upstream failure text (observed live on dsh 0.1.5-rc.1/rc.2; upstream
 * discussions deepseek-ai/deepseek-harness #4361 and #3158):
 *
 * - pi-ai (`openai-completions`) maps an unrecognized wire `finish_reason` to
 *   `stopReason: 'error'` with the verbatim message
 *   `Provider finish_reason: <reason>`; dsh's stock classifier's
 *   `\bnetwork\b` cannot see the underscore spelling (underscore is a word
 *   character), so e.g. `network_error` lands as non-retryable `PI_AI_ERROR`.
 * - the DeepSeek adapter maps unknown finish reasons to
 *   `model stopped: <reason>` with code `<REASON>` upper-cased, so
 *   `network_error` arrives as code `NETWORK_ERROR`, also outside the
 *   default retryable codes.
 * - gateway-echoed transport texts reach the classifier bare (SSE error
 *   payloads and error-body echoes carry the gateway's own upstream stack
 *   text; pi-ai's `formatProviderError` passes message-only errors through
 *   unchanged): `unexpected EOF` (a response body cut short — Go's
 *   `io.ErrUnexpectedEOF`, Node's `HPE_UNEXPECTED_EOF*`, zlib's truncated
 *   gunzip `unexpected end of file`), `remote error: tls: bad record MAC`
 *   (a fatal TLS alert from the remote side, Go rendering), and
 *   `stream_read_error` (#3158). None matches a stock branch, so all land as
 *   `PI_AI_ERROR`.
 *
 * ## dsh 0.1.7-rc.1: the official DeepSeek adapter is Messages API-only
 *
 * Chat Completions and the `protocol` option are gone (`llm-deepseek`
 * serialize/adapter); the Messages wire (`POST /messages`, anthropic-style
 * SSE) sources error text differently. Audited at tag `dsh-v0.1.7-rc.1`:
 *
 * - Unknown `stop_reason` values (anthropic spellings `end_turn` /
 *   `stop_sequence` / `tool_use` / `max_tokens` are the only ones
 *   translated) throw `DeepSeek Messages stream: unsupported stop reason
 *   <reason>` with code `MALFORMED_RESPONSE` (`translate.ts` `stopReason`) —
 *   the successor of the `provider finish_reason:` face above; a
 *   `network_error` spelling is already claimed by {@link NETWORK_ERROR},
 *   every other reason is claimed by {@link UNSUPPORTED_STOP_REASON}.
 * - A stream that ends cleanly before `message_stop` (gateway half-close,
 *   proxy failover after headers) is NOT a read error on this wire: the SSE
 *   decoder simply finishes, and the translator throws
 *   `DeepSeek Messages stream ended before message_stop` (`STREAM_CLOSED`),
 *   mirrored by pi-ai's `pi-ai event stream ended without done/error`
 *   (`llm-pi-ai` `stream.ts`). `STREAM_CLOSED` is outside the stock
 *   retryable set, so {@link STREAM_ENDED_EARLY} claims it.
 * - Everything that throws on the read path (fetch rejects, body read
 *   errors, TLS alerts, undici truncation) is wrapped by the adapter into
 *   `DeepSeek Messages transport failed` with code `TRANSPORT`
 *   (`adapter.ts` generate catch) — the stock policy owns those and the code
 *   guard keeps the net out of the way. In-band SSE `error` events classify
 *   via `transport.ts` `providerError` and can only land on blocked codes
 *   (AUTH/QUOTA/RATE_LIMIT/CONTEXT_WINDOW_EXCEEDED/INVALID_REQUEST/SERVER),
 *   so gateway text echoed there is the stock policy's to retry.
 * - pi-ai remains multi-protocol (`openai-completions` API still mounted in
 *   `llm-pi-ai` `provider.ts`), and its new `classifyPiAiError` leaves the
 *   leaked wordings above as `PI_AI_ERROR` — the e2e suite exercises that
 *   wire unchanged. pi-ai provider wordings meaning "stream ended before or
 *   without a terminal event" are classified `TRANSPORT` by pi-ai itself
 *   (same `/stream ended (?:before|without)/` rule as
 *   {@link STREAM_ENDED_EARLY}); the code guard resolves the overlap: only
 *   the `STREAM_CLOSED` spills are ours.
 *
 * Note that undici's OWN truncation wording (`terminated`, cause
 * `other side closed`) and plain mid-stream connection errors
 * (`Connection error.` from the openai SDK) are already stock `TRANSPORT`
 * and deliberately NOT matched here.
 *
 * ## Code guard: the net only claims failures the stock taxonomy did not
 *
 * `isLeakedNetworkFailure` takes the failure's code and declines codes whose
 * recovery the harness already owns:
 *
 * - the stock retry policy's default retryable set (dsh-llm
 *   `DEFAULT_RETRYABLE_CODES`) — the stock policy owns recovery for these,
 *   including its decision to stop after maxRetries; stacking a second
 *   bounded retry on top would double the attempt budget behind the user's
 *   back.
 * - permanent failures (`AUTH`, `INVALID_REQUEST`, `CONTEXT_WINDOW_EXCEEDED`,
 *   `QUOTA`, `ACCOUNT_QUOTA`, `INVALID_CREDENTIAL`) — no retry can change the outcome.
 * - caller aborts (`ABORTED`).
 *
 * This is also what makes the net stand down automatically if upstream later
 * reclassifies any of these wordings (e.g. `unexpected EOF` → `TRANSPORT`):
 * the stock policy starts retrying them and the guard keeps this net out of
 * the way. Everything else — the catch-all `PI_AI_ERROR`, the DeepSeek
 * unknown-reason codes (e.g. `NETWORK_ERROR`), raw-throw `UNKNOWN`,
 * oddball `HTTP_<status>` codes, and the Messages wire's protocol codes
 * `MALFORMED_RESPONSE` / `STREAM_CLOSED` / `UNSUPPORTED_CONTENT` — falls
 * through to the message patterns. The stock set was re-verified unchanged
 * at dsh 0.1.7-rc.1 (`llm/src/retry-policy.ts` `DEFAULT_RETRYABLE_CODES`).
 * The dsh 0.1.7-rc.2 audit found that dsh-llm `error.d.ts` added the
 * account-quota code `ACCOUNT_QUOTA`; this list now includes it (audited at
 * tag `dsh-v0.1.7-rc.2`).
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
 * The Messages wire's successor of the finish_reason face: the official
 * DeepSeek adapter translates exactly four anthropic `stop_reason` spellings
 * and throws `DeepSeek Messages stream: unsupported stop reason <reason>`
 * (`MALFORMED_RESPONSE`) for anything else a gateway invents. Claimed for
 * every reason — same "any unrecognized terminal reason" parity as
 * {@link PROVIDER_FINISH_REASON}; a `network_error` spelling is already
 * covered by {@link NETWORK_ERROR} and this adds the rest.
 */
const UNSUPPORTED_STOP_REASON = /\bunsupported stop reason\b/i

/**
 * A response body cut short without a provider-specific truncation wording:
 * Go's `io.ErrUnexpectedEOF` (`unexpected EOF`), Node's HTTP parser variant
 * (`HPE_UNEXPECTED_EOF...` — underscore joins the words), zlib's truncated
 * gunzip (`unexpected end of file`). The `_`/`-`/space spellings are all
 * accepted and no trailing boundary is required so parser-prefixed renderings
 * (`HPE_UNEXPECTED_EOF_CONTENT_LENGTH`) still match.
 */
const UNEXPECTED_EOF = /unexpected[ _-]?EOF|unexpected end of file/i

/**
 * A fatal TLS alert raised by the remote side — Go's stack renders these as
 * `remote error: tls: <alert>`; `bad record MAC` (corrupted record) is the
 * case observed live behind relays (#4361 comment 18418461).
 */
const TLS_ALERT = /\bbad record MAC\b|remote error:\s*tls:/i

/** A gateway-normalized mid-stream read failure (#3158). */
const STREAM_READ_ERROR = /\bstream[_\s-]+read[_\s-]+error\b/i

/**
 * A gateway stream that ended before the provider's terminal event: the
 * Messages translator's `DeepSeek Messages stream ended before message_stop`
 * and pi-ai's `pi-ai event stream ended without done/error`, both code
 * `STREAM_CLOSED` (a clean SSE close is not a read error, so the adapter's
 * `TRANSPORT` wrap never sees it). Same wording rule pi-ai upstream applies
 * to its own provider truncation texts when classifying them `TRANSPORT` —
 * here the code guard does the split: `TRANSPORT` copies stand down, only
 * the unclassified `STREAM_CLOSED` spills are claimed.
 */
const STREAM_ENDED_EARLY = /stream ended (?:before|without)\b/i

/**
 * Codes the net never claims: the stock policy's default retryable set, the
 * permanent failure codes, and caller aborts. DeepSeek's unknown-reason codes
 * (e.g. `NETWORK_ERROR`), pi-ai's `PI_AI_ERROR` catch-all, raw-throw
 * `UNKNOWN`, and oddball `HTTP_<status>` codes fall through to the message
 * patterns.
 */
const NOT_OURS: ReadonlySet<string> = new Set([
  // dsh-llm DEFAULT_RETRYABLE_CODES: the stock policy owns recovery, including
  // its decision to stop retrying.
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  // Permanent failures: a retry cannot change the outcome.
  'AUTH',
  'INVALID_CREDENTIAL',
  'INVALID_REQUEST',
  'CONTEXT_WINDOW_EXCEEDED',
  'QUOTA',
  'ACCOUNT_QUOTA',
  // User-initiated.
  'ABORTED',
])

/**
 * Whether a failure names a network failure the stock retry policy could not
 * classify: the failure must carry a code outside {@link NOT_OURS} AND its
 * message must name a leaked network variant.
 * @param message - the LLM failure message.
 * @param code - the LLM failure code (harness taxonomy, e.g. `PI_AI_ERROR`).
 * @returns true when the net should claim the failure.
 */
export function isLeakedNetworkFailure(message: string, code: string): boolean {
  if (NOT_OURS.has(code)) return false
  return NETWORK_ERROR.test(message)
    || PROVIDER_FINISH_REASON.test(message)
    || UNSUPPORTED_STOP_REASON.test(message)
    || UNEXPECTED_EOF.test(message)
    || TLS_ALERT.test(message)
    || STREAM_READ_ERROR.test(message)
    || STREAM_ENDED_EARLY.test(message)
}
