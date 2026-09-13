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
