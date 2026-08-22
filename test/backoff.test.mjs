import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localDelay, resolveConfig } from '../lib/index.js'

const base = resolveConfig({ backoff: { initialDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0.1 } })

test('exponential growth clamped at maxDelayMs, deterministic without jitter', () => {
  const flat = resolveConfig({ backoff: { initialDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0 } })
  assert.equal(localDelay(flat, 1, Math.random), 100)
  assert.equal(localDelay(flat, 2, Math.random), 200)
  assert.equal(localDelay(flat, 3, Math.random), 400)
  assert.equal(localDelay(flat, 4, Math.random), 800)
  assert.equal(localDelay(flat, 5, Math.random), 1_000)
  assert.equal(localDelay(flat, 50, Math.random), 1_000)
})

test('jitter is symmetric around the local delay and stays in range', () => {
  for (const sample of [0, 0.25, 0.5, 0.75, 1]) {
    const delay = localDelay(base, 2, () => sample)
    // jitter factor = 1 - 0.1 + 0.2 * sample, delay = 200 * factor, capped at 1000
    const expected = Math.min(200 * (0.9 + 0.2 * sample), 1_000)
    assert.equal(delay, expected)
  }
})

test('defaults match the documented policy', () => {
  const defaults = resolveConfig(undefined)
  assert.equal(defaults.mode, 'on')
  assert.equal(defaults.maxRetries, 5)
  assert.equal(defaults.initialDelayMs, 500)
  assert.equal(defaults.maxDelayMs, 10_000)
  assert.equal(defaults.jitterRatio, 0.1)
})

test('resolveConfig rejects unknown keys and invalid values', () => {
  assert.throws(() => resolveConfig({ nope: 1 }), /unknown key "nope"/)
  assert.throws(() => resolveConfig({ backoff: { nope: 1 } }), /unknown key "nope"/)
  assert.throws(() => resolveConfig({ maxRetries: 1.5 }), /maxRetries/)
  assert.throws(() => resolveConfig({ maxRetries: -1 }), /maxRetries/)
  assert.throws(() => resolveConfig({ backoff: { initialDelayMs: 0 } }), /initialDelayMs/)
  assert.throws(() => resolveConfig({ backoff: { maxDelayMs: 50, initialDelayMs: 100 } }), /less than or equal/)
  assert.throws(() => resolveConfig({ backoff: { jitterRatio: 2 } }), /jitterRatio/)
})

test('mode off resolves without touching other defaults', () => {
  const off = resolveConfig({ mode: 'off' })
  assert.equal(off.mode, 'off')
  assert.equal(off.maxRetries, 5)
})
