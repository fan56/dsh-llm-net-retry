import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as NetRetry from '../lib/index.js'

const FAST = { maxRetries: 2, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }
const NETWORK_FAILURE = { message: 'Provider finish_reason: network_error', code: 'PI_AI_ERROR' }

async function setup(config = FAST) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(NetRetry, config)
  const session = ctx.sessions.create(SessionId(`decision-${Math.random().toString(36).slice(2)}`))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', {
    header: { config: { provider: 'mock', model: 'mock' } },
    reason: 'initial',
  })
  const agent = { session }
  return { ctx, session, agent }
}

function dispatch(ctx, agent, failure, next) {
  return ctx.waterfall('agent/request-error', {
    agent,
    turn: 1,
    step: 1,
    provider: 'mock',
    failure,
    retryPolicy: undefined,
    signal: new AbortController().signal,
  }, next ?? (() => Promise.resolve(undefined)))
}

const retryEvents = session =>
  session.snapshotEvents().filter(event => event.type === 'llm/retry')
const startedEvents = session =>
  session.snapshotEvents().filter(event => event.type === 'llm/retry-started')

test('retries a leaked network failure every downstream listener declined', async () => {
  const { ctx, session, agent } = await setup()
  try {
    const decision = await dispatch(ctx, agent, NETWORK_FAILURE)
    assert.deepEqual(decision, { kind: 'retry' })
    const events = retryEvents(session)
    assert.equal(events.length, 1)
    const data = events[0].data
    assert.equal(data.retry, 1)
    assert.equal(data.maxRetries, 2)
    assert.equal(data.provider, 'mock')
    assert.equal(data.turn, 1)
    assert.equal(data.step, 1)
    assert.equal(data.failure.message, 'Provider finish_reason: network_error')
    assert.ok(data.policyKey.includes('net-retry:v1'), data.policyKey)
    assert.ok(typeof data.retryId === 'string')
    assert.deepEqual(startedEvents(session).map(event => event.data.retry), [1])
    assert.equal(startedEvents(session)[0].data.retryId, data.retryId)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('passes an upstream retry decision through untouched', async () => {
  const { ctx, session, agent } = await setup()
  try {
    const upstream = { kind: 'retry' }
    const decision = await dispatch(ctx, agent, NETWORK_FAILURE, () => Promise.resolve(upstream))
    assert.equal(decision, upstream)
    assert.equal(retryEvents(session).length, 0)
    assert.equal(startedEvents(session).length, 0)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('passes a declined non-network failure through', async () => {
  const { ctx, session, agent } = await setup()
  try {
    const decision = await dispatch(ctx, agent, { message: 'HTTP 400: invalid request', code: 'INVALID_REQUEST' })
    assert.equal(decision, undefined)
    assert.equal(retryEvents(session).length, 0)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('counts retries per turn/step under its own policy key and stops at maxRetries', async () => {
  const { ctx, session, agent } = await setup()
  try {
    assert.deepEqual(await dispatch(ctx, agent, NETWORK_FAILURE), { kind: 'retry' })
    assert.deepEqual(await dispatch(ctx, agent, NETWORK_FAILURE), { kind: 'retry' })
    assert.equal(await dispatch(ctx, agent, NETWORK_FAILURE), undefined)

    const events = retryEvents(session)
    assert.deepEqual(events.map(event => event.data.retry), [1, 2])
    const ids = new Set(events.map(event => event.data.retryId))
    assert.equal(ids.size, 1, 'retry chain keeps one retryId')
    assert.deepEqual(startedEvents(session).map(event => event.data.retry), [1, 2])
  } finally {
    await ctx.fiber.dispose()
  }
})

test('an aborted turn signal prevents any durable retry record', async () => {
  const { ctx, session, agent } = await setup()
  try {
    const controller = new AbortController()
    controller.abort()
    const decision = await ctx.waterfall('agent/request-error', {
      agent,
      turn: 1,
      step: 1,
      provider: 'mock',
      failure: NETWORK_FAILURE,
      retryPolicy: undefined,
      signal: controller.signal,
    }, () => Promise.resolve(undefined))
    assert.equal(decision, undefined)
    assert.equal(retryEvents(session).length, 0)
    assert.equal(startedEvents(session).length, 0)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('mode off leaves the waterfall untouched', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(NetRetry, { mode: 'off' })
  const session = ctx.sessions.create(SessionId('decision-off'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', {
    header: { config: { provider: 'mock', model: 'mock' } },
    reason: 'initial',
  })
  try {
    const decision = await dispatch(ctx, { session }, NETWORK_FAILURE)
    assert.equal(decision, undefined)
    assert.equal(retryEvents(session).length, 0)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('a downstream recovery error still reaches the net', async () => {
  const { ctx, session, agent } = await setup()
  try {
    const decision = await dispatch(ctx, agent, NETWORK_FAILURE, () => Promise.reject(new Error('listener exploded')))
    assert.deepEqual(decision, { kind: 'retry' })
    assert.equal(retryEvents(session).length, 1)
  } finally {
    await ctx.fiber.dispose()
  }
})
