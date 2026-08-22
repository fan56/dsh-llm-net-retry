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
