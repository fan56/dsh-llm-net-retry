import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isLeakedNetworkFailure } from '../lib/match.js'

// The catch-all the stock classifier assigns every leaked wording below.
const LEAK = 'PI_AI_ERROR'

test('matches the known leaked network-error spellings', () => {
  for (const [message, code] of [
    ['Provider finish_reason: network_error', LEAK],
    ['Provider finish_reason: network-error', LEAK],
    ['model stopped: network_error', 'NETWORK_ERROR'],
    ['model stopped: network-error', 'NETWORK_ERROR'],
    ['gateway reported network error mid-stream', LEAK],
    ['NETWORK_ERROR from upstream', 'UNKNOWN'],
  ]) {
    assert.equal(isLeakedNetworkFailure(message, code), true, `${message} (${code})`)
  }
})

test('matches the transport wordings reported in #4361/#3158 (gateway-echoed texts)', () => {
  for (const [message, code] of [
    // #4361 comment 18418461: a response body cut short mid-stream.
    ['unexpected EOF', LEAK],
    ['Error: unexpected EOF', LEAK],
    ['Parse Error: HPE_UNEXPECTED_EOF_CONTENT_LENGTH', LEAK],
    ['unexpected end of file', LEAK],
    // #4361 comment 18418461: a corrupted TLS record (Go's rendering).
    ['remote error: tls: bad record MAC', LEAK],
    ['remote error: tls: bad record mac', LEAK],
    ['bad record MAC', LEAK],
    // #3158: a gateway-normalized mid-stream read failure.
    ['stream_read_error', LEAK],
    ['stream read error', LEAK],
    ['stream-read-error', LEAK],
  ]) {
    assert.equal(isLeakedNetworkFailure(message, code), true, `${message} (${code})`)
  }
})

test('matches any unrecognized provider finish_reason, not only network', () => {
  assert.equal(isLeakedNetworkFailure('Provider finish_reason: content_filter', LEAK), true)
})

// Fixtures sampled from the official adapter's Messages-path error
// construction at tag dsh-v0.1.7-rc.1 (packages/llm/llm-deepseek/src).
test('matches the Messages-wire wordings (dsh 0.1.7-rc.1 llm-deepseek)', () => {
  for (const [message, code] of [
    // translate.ts stopReason(): the Messages successor of the
    // `provider finish_reason:` face; a network_error spelling is already
    // covered by the network pattern, every other reason lands here.
    ['DeepSeek Messages stream: unsupported stop reason tool_use', 'MALFORMED_RESPONSE'],
    ['DeepSeek Messages stream: unsupported stop reason model_len_limit', 'MALFORMED_RESPONSE'],
    // translate.ts tail: the stream ended cleanly (gateway half-close, proxy
    // failover after headers) — not a read error, so the adapter's TRANSPORT
    // wrap never sees it.
    ['DeepSeek Messages stream ended before message_stop', 'STREAM_CLOSED'],
    // llm-pi-ai stream.ts: the same truncation face on the pi-ai wire.
    ['pi-ai event stream ended without done/error', 'STREAM_CLOSED'],
  ]) {
    assert.equal(isLeakedNetworkFailure(message, code), true, `${message} (${code})`)
  }
})

test('Messages-wire transport and in-band errors stay with the stock policy', () => {
  for (const [message, code] of [
    // adapter.ts generate catch wraps every read-path throw (fetch rejects,
    // body read errors, TLS alerts, undici truncation) into TRANSPORT.
    ['DeepSeek Messages transport failed', 'TRANSPORT'],
    // transport.ts providerError: in-band SSE error events always classify
    // into blocked codes, even when the gateway echoes a leaked wording.
    ['unexpected EOF', 'SERVER'],
    ['stream_read_error', 'SERVER'],
    ['DeepSeek Messages request failed (stream error)', 'SERVER'],
    // pi-ai classifyPiAiError marks its own provider truncation texts
    // TRANSPORT; the code guard resolves the overlap with STREAM_ENDED_EARLY.
    ['mock stream ended before a terminal response event', 'TRANSPORT'],
    ['Stream ended without finish_reason', 'TRANSPORT'],
    // adapter.ts: idle watchdog and clean-empty settlements.
    ['DeepSeek Messages stream idle timeout', 'TIMEOUT'],
    ['DeepSeek Messages returned no content', 'EMPTY_RESPONSE'],
    // translate.ts/sse.ts protocol corruption that names no network failure.
    ['DeepSeek Messages SSE contains invalid JSON', 'MALFORMED_RESPONSE'],
    ['DeepSeek Messages SSE event type mismatch', 'MALFORMED_RESPONSE'],
    ['DeepSeek Messages stream: unsupported delta text_delta for reasoning', 'MALFORMED_RESPONSE'],
  ]) {
    assert.equal(isLeakedNetworkFailure(message, code), false, `${message} (${code})`)
  }
})

test('the guard declines codes whose recovery the stock policy owns', () => {
  // Once upstream reclassifies a wording (e.g. `unexpected EOF` → TRANSPORT)
  // the stock policy retries it and the net must stand down.
  for (const code of ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']) {
    assert.equal(isLeakedNetworkFailure('unexpected EOF', code), false, code)
    assert.equal(isLeakedNetworkFailure('remote error: tls: bad record MAC', code), false, code)
    assert.equal(isLeakedNetworkFailure('stream_read_error', code), false, code)
    assert.equal(isLeakedNetworkFailure('Provider finish_reason: network_error', code), false, code)
    assert.equal(isLeakedNetworkFailure('model stopped: network_error', code), false, code)
  }
})

test('the guard declines permanent failures and caller aborts', () => {
  for (const code of ['AUTH', 'INVALID_CREDENTIAL', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'QUOTA', 'ABORTED']) {
    assert.equal(isLeakedNetworkFailure('unexpected EOF', code), false, code)
    assert.equal(isLeakedNetworkFailure('Provider finish_reason: network_error', code), false, code)
  }
})

test('does not match failures the stock policy already owns', () => {
  for (const [message, code] of [
    ['other side closed', 'TRANSPORT'],
    ['terminated', 'TRANSPORT'],
    ['Connection error.', 'TRANSPORT'],
    ['HTTP 500: backend down', 'SERVER'],
    ['HTTP 429: rate limit', 'RATE_LIMIT'],
    ['ECONNRESET socket closed', 'TRANSPORT'],
    ['provider timed out', 'TIMEOUT'],
    ['empty response from provider', 'EMPTY_RESPONSE'],
    ['invalid request: temperature out of range', 'INVALID_REQUEST'],
    ['insufficient quota', 'QUOTA'],
    ['HTTP 401 Unauthorized', 'AUTH'],
    ['', LEAK],
  ]) {
    assert.equal(isLeakedNetworkFailure(message, code), false, `${message} (${code})`)
  }
})

test('near-miss spellings stay unmatched', () => {
  for (const [message, code] of [
    ['networkerror', LEAK], // no separator between network and error
    ['unexpectedly EOF', LEAK], // "unexpected" is not followed by a separator or EOF
    ['bad record MACintosh', LEAK], // trailing word characters break the boundary
    ['streamed read error', LEAK], // "stream" is not followed by a separator
  ]) {
    assert.equal(isLeakedNetworkFailure(message, code), false, `${message} (${code})`)
  }
})
