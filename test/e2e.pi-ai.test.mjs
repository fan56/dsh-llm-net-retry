import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { test } from 'node:test'

// Isolation: this suite must never touch the live ~/.dsh tree.
process.env.HOME = mkdtempSync(join(tmpdir(), 'dsh-net-retry-e2e-'))
process.env.NET_RETRY_TEST_KEY = 'test-key'

import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as Retry from '@deepseek-ai/dsh-llm-retry'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as NetRetry from '../lib/index.js'

/** A gateway stop chunk reporting its own upstream connection failure. */
const NETWORK_ERROR_CHUNK = '{"choices":[{"delta":{},"index":0,"finish_reason":"network_error"}]}'

const SUCCESS_EVENTS = [
  '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"content":"recovered via net-retry"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":5}}',
]

/**
 * OpenAI-compatible SSE gateway that answers the first `failures` requests
 * with a network_error finish_reason and every later one with plain text.
 */
function startGateway(failures) {
  let requests = 0
  const bodies = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk.toString('utf8') })
    request.on('end', () => {
      bodies.push(body.length === 0 ? undefined : JSON.parse(body))
      const failed = requests < failures
      requests += 1
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (failed) {
        response.write(`data: ${NETWORK_ERROR_CHUNK}\n\n`)
        response.write('data: [DONE]\n\n')
        response.end()
        return
      }
      for (const event of SUCCESS_EVENTS) response.write(`data: ${event}\n\n`)
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise(done => server.close(() => done())),
        get requestCount() { return requests },
        bodies,
      })
    })
  })
}

async function harness(gatewayURL, netRetryConfig) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  // dsh 0.1.5-rc.1: the testkit now mounts SessionProjectionRegistry itself
  // (providing `sessionProjections`) — plugging SessionProjections here again
  // throws "service has been registered". AgentLoop stays caller-supplied.
  await ctx.plugin(LlmPiAi, {
    providers: {
      mockgw: {
        apiKeyEnv: 'NET_RETRY_TEST_KEY',
        api: 'openai-completions',
        baseURL: gatewayURL,
        models: [{ id: 'ox-alpha-free' }],
      },
    },
  })
  await ctx.plugin(Retry)
  if (netRetryConfig !== null) await ctx.plugin(NetRetry, netRetryConfig)
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

function finalAssistantText(agent) {
  const message = agent.session.deriveMessages().at(-1)
  if (message?.role !== 'assistant') return undefined
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function sendAndWait(agent) {
  const idle = agent.whenIdle()
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'recover through the gateway boundary' }],
    source: { kind: 'user' },
  }))
  return idle
}

test('e2e: retries two gateway network_error finishes and completes the turn', async () => {
  const gateway = await startGateway(2)
  const ctx = await harness(gateway.url, { maxRetries: 3, backoff: { initialDelayMs: 5, maxDelayMs: 5, jitterRatio: 0 } })
  try {
    const agent = await ctx.agentLoop.create(SessionId('e2e-net-retry'), {
      provider: 'mockgw',
      model: 'ox-alpha-free',
    })
    await sendAndWait(agent)

    assert.equal(gateway.requestCount, 3, 'two failures plus the successful third request')
    assert.equal(finalAssistantText(agent), 'recovered via net-retry')

    const retryEvents = agent.session.snapshotEvents().filter(event => event.type === 'llm/retry')
    assert.deepEqual(retryEvents.map(event => event.data.retry), [1, 2])
    for (const event of retryEvents) {
      assert.equal(event.data.provider, 'mockgw')
      assert.equal(event.data.failure.message, 'Provider finish_reason: network_error')
      assert.ok(event.data.policyKey.includes('net-retry:v1'), event.data.policyKey)
    }
    const started = agent.session.snapshotEvents().filter(event => event.type === 'llm/retry-started')
    assert.deepEqual(started.map(event => event.data.retry), [1, 2])
    assert.equal(new Set(retryEvents.map(event => event.data.retryId)).size, 1)
  } finally {
    await ctx.fiber.dispose()
    await gateway.close()
  }
})

test('e2e negative control: without the plugin the first network_error fails the turn', async () => {
  const gateway = await startGateway(1)
  const ctx = await harness(gateway.url, null)
  try {
    const agent = await ctx.agentLoop.create(SessionId('e2e-net-retry-off'), {
      provider: 'mockgw',
      model: 'ox-alpha-free',
    })
    await sendAndWait(agent)

    assert.equal(gateway.requestCount, 1, 'the stock policy does not retry the misclassified failure')
    assert.equal(finalAssistantText(agent), undefined)
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry').length, 0)
  } finally {
    await ctx.fiber.dispose()
    await gateway.close()
  }
})
