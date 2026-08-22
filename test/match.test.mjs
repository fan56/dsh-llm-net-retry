import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isLeakedNetworkFailure } from '../lib/match.js'

test('matches the known leaked network-error spellings', () => {
  for (const message of [
    'Provider finish_reason: network_error',
    'model stopped: network_error',
    'model stopped: network-error',
    'gateway reported network error mid-stream',
    'NETWORK_ERROR from upstream',
    'Provider finish_reason: network-error',
  ]) {
    assert.equal(isLeakedNetworkFailure(message), true, message)
  }
})

test('does not match failures the stock policy already owns', () => {
  for (const message of [
    'other side closed',
    'terminated',
    'HTTP 500: backend down',
    'HTTP 429: rate limit',
    'ECONNRESET socket closed',
    'provider timed out',
    'invalid request: temperature out of range',
    'insufficient quota',
    '',
  ]) {
    assert.equal(isLeakedNetworkFailure(message), false, message)
  }
})

test('matches any unrecognized provider finish_reason, not only network', () => {
  assert.equal(isLeakedNetworkFailure('Provider finish_reason: content_filter'), true)
})
