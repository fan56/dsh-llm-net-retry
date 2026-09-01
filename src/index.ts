/**
 * dsh-llm-net-retry — bounded retry for gateway network failures the stock
 * retry policy cannot classify.
 *
 * Sits at the END of the `agent/request-error` waterfall: it first lets the
 * provider's policy executors (dsh-llm-retry) decide, and only when every one
 * of them declined (`next()` resolved undefined) AND the failure message names
 * a leaked network variant does it schedule its own bounded retry. Retries
 * are durable (`llm/retry` / `llm/retry-started` session events, schema- and
 * shape-compatible with dsh-llm-retry's, so TUI surfaces them unchanged) and
 * counted under this plugin's own policy key, never touching llm-retry's.
 *
 * @module @aiwayds/dsh-llm-net-retry
 */

import { randomUUID } from 'node:crypto'
import type { Context, Events } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { isLeakedNetworkFailure } from './match.ts'
import { RetryId, type LlmRetryEventData, type LlmRetryStartedEventData } from './types.ts'

export { isLeakedNetworkFailure } from './match.ts'
export type { LlmRetryEventData, LlmRetryStartedEventData } from './types.ts'
export { RetryId } from './types.ts'

export const name = 'dsh-llm-net-retry'
export const inject = ['agents']

/** Ceiling for one scheduled setTimeout, beyond which Node clamps to 1ms. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

const DEFAULT_MAX_RETRIES = 5
const DEFAULT_INITIAL_DELAY_MS = 500
const DEFAULT_MAX_DELAY_MS = 10_000
const DEFAULT_JITTER_RATIO = 0.1

/** Plugin configuration. */
export interface Config {
  /** `off` disables the listener entirely (default `on`). */
  mode?: 'on' | 'off'
  /** Maximum eligible retries after the first request (default 5). */
  maxRetries?: number
  /** Local exponential-backoff and jitter configuration. */
  backoff?: {
    /** Initial local exponential-backoff delay in milliseconds (default 500). */
    initialDelayMs?: number
    /** Maximum locally scheduled delay in milliseconds (default 10000). */
    maxDelayMs?: number
    /** Symmetric random multiplier range around one (default 0.1). */
    jitterRatio?: number
  }
}

/** Runtime schema for {@link Config}. */
export const Config = z.object({
  mode: z.union([z.const('on'), z.const('off')]).default('on'),
  maxRetries: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_RETRIES),
  backoff: z.object({
    initialDelayMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_INITIAL_DELAY_MS),
    maxDelayMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_MAX_DELAY_MS),
    jitterRatio: z.number().min(0).max(1).default(DEFAULT_JITTER_RATIO),
  }),
}) as unknown as z<Config>

const CONFIG_KEYS: ReadonlySet<string> = new Set(['mode', 'maxRetries', 'backoff'])
const BACKOFF_KEYS: ReadonlySet<string> = new Set(['initialDelayMs', 'maxDelayMs', 'jitterRatio'])

function validateKeys(value: object, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`dsh-llm-net-retry: ${path}: unknown key "${key}"`)
  }
}

/** Fully resolved plugin policy captured at apply time. */
export interface ResolvedConfig {
  readonly mode: 'on' | 'off'
  readonly maxRetries: number
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
}

/**
 * Validate, default, and detach the plugin configuration.
 * @param config - optional plugin configuration; omission selects defaults.
 * @returns an immutable policy safe to capture in listener state.
 */
export function resolveConfig(config: Config | undefined): ResolvedConfig {
  const mode = config?.mode ?? 'on'
  if (mode !== 'on' && mode !== 'off') {
    throw new Error('dsh-llm-net-retry: mode must be "on" or "off"')
  }
  if (config !== undefined) validateKeys(config, CONFIG_KEYS, 'config')
  const backoff = config?.backoff
  if (backoff !== undefined) validateKeys(backoff, BACKOFF_KEYS, 'config.backoff')

  const maxRetries = config?.maxRetries ?? DEFAULT_MAX_RETRIES
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new Error('dsh-llm-net-retry: maxRetries must be a non-negative safe integer')
  }
  const initialDelayMs = backoff?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  const maxDelayMs = backoff?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const jitterRatio = backoff?.jitterRatio ?? DEFAULT_JITTER_RATIO
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0 || initialDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`dsh-llm-net-retry: config.backoff.initialDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0 || maxDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`dsh-llm-net-retry: config.backoff.maxDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (initialDelayMs > maxDelayMs) {
    throw new Error('dsh-llm-net-retry: config.backoff.initialDelayMs must be less than or equal to maxDelayMs')
  }
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new Error('dsh-llm-net-retry: config.backoff.jitterRatio must be between 0 and 1')
  }
  return Object.freeze({ mode, maxRetries, initialDelayMs, maxDelayMs, jitterRatio })
}

/** Stable key separating this plugin's retry counting from llm-retry's. */
function netRetryPolicyKey(config: ResolvedConfig): string {
  return JSON.stringify([
    'net-retry:v1',
    config.maxRetries,
    config.initialDelayMs,
    config.maxDelayMs,
    config.jitterRatio,
  ])
}

/** Bounded exponential backoff with symmetric jitter around each local delay. */
export function localDelay(
  config: Pick<ResolvedConfig, 'initialDelayMs' | 'maxDelayMs' | 'jitterRatio'>,
  retry: number,
  random: () => number,
): number {
  const exponent = Math.min(retry - 1, 1024)
  const exponential = Math.min(config.initialDelayMs * 2 ** exponent, config.maxDelayMs)
  const jitter = 1 - config.jitterRatio + 2 * config.jitterRatio * random()
  return Math.min(exponential * jitter, config.maxDelayMs)
}

/** Non-serializable hooks used to make timing policy deterministic in tests. */
export interface RetryInternals {
  /** Random sample in the inclusive zero-to-one range used for jitter. */
  random?: () => number
}

type DownstreamOutcome =
  | { readonly type: 'decision'; readonly decision: RequestErrorAction }
  | { readonly type: 'error'; readonly error: unknown }

async function settleDownstream(
  next: () => Promise<RequestErrorAction>,
): Promise<DownstreamOutcome> {
  try {
    return { type: 'decision', decision: await next() }
  } catch (error: unknown) {
    return { type: 'error', error }
  }
}

function cancellableDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort(): void {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Install the trailing network-failure safety net on the request-error
 * waterfall.
 * @param ctx - plugin context that owns the listener and active waits.
 * @param config - plugin configuration; omission selects defaults.
 * @param internals - non-serializable deterministic hooks for tests.
 */
export function apply(ctx: Context, config: Config = {}, internals: RetryInternals = {}): void {
  const policy = resolveConfig(config)
  if (policy.mode === 'off') return
  const random = internals.random ?? Math.random
  const policyKey = netRetryPolicyKey(policy)
  const lifetime = new AbortController()
  const active = new Set<Promise<RequestErrorAction>>()

  function track(operation: Promise<RequestErrorAction>): Promise<RequestErrorAction> {
    const tracked = operation.finally(() => active.delete(tracked))
    active.add(tracked)
    return tracked
  }

  async function backoff(
    agent: Agent,
    turn: number,
    step: number,
    failure: LlmFailure,
    provider: string,
    retry: number,
    retryId: RetryId,
    delayMs: number,
    signal: AbortSignal,
  ): Promise<RequestErrorAction> {
    const fusedSignal = AbortSignal.any([signal, lifetime.signal])
    if (fusedSignal.aborted) return
    const eventData: LlmRetryEventData = {
      retryId,
      turn,
      step,
      provider,
      mode: 'normal',
      policyKey,
      retry,
      maxRetries: policy.maxRetries,
      delayMs,
      failure,
    }
    agent.session.append('llm/retry', eventData)
    if (!await cancellableDelay(delayMs, fusedSignal)) return
    const started: LlmRetryStartedEventData = { retryId, turn, step, retry }
    agent.session.append('llm/retry-started', started)
    return { kind: 'retry' }
  }

  async function recover(
    { agent, turn, step, provider, failure, signal }: Parameters<Events['agent/request-error']>[0],
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> {
    // The provider's own policy executors decide first; this net only acts
    // when the whole waterfall declined (decision undefined). If a downstream
    // listener threw, log and fall through to the net rather than masking it.
    const downstream = await settleDownstream(next)
    if (downstream.type === 'error') {
      ctx.logger.warn(
        'dsh-llm-net-retry: downstream recovery failure on provider "%s": %o',
        provider,
        downstream.error,
      )
    }
    if (downstream.type === 'decision' && downstream.decision !== undefined) {
      return downstream.decision
    }
    if (lifetime.signal.aborted || signal.aborted) return
    if (!isLeakedNetworkFailure(failure.message)) return

    const priorNetRetry = agent.session.snapshotEvents().findLast((event): event is SessionEvent<'llm/retry'> =>
      event.type === 'llm/retry'
      && event.data.turn === turn
      && event.data.step === step
      && event.data.provider === provider
      && event.data.policyKey === policyKey,
    )
    const previousRetry = priorNetRetry?.data.retry ?? 0
    if (previousRetry >= policy.maxRetries) return
    const retry = previousRetry + 1
    const retryId = priorNetRetry?.data.retryId ?? RetryId(randomUUID())
    const delayMs = localDelay(policy, retry, random)
    return backoff(agent, turn, step, failure, provider, retry, retryId, delayMs, signal)
  }

  const disposeListener = ctx.on('agent/request-error', (
    payload,
    next: () => Promise<RequestErrorAction>,
  ) => {
    // A waterfall may have captured this callback before its registration was
    // removed. Lifetime cancellation must prevent that stale callback from
    // scheduling a retry after disposal.
    if (lifetime.signal.aborted) return Promise.resolve<RequestErrorAction>(undefined)
    return track(recover(payload, next))
  })

  ctx.effect(() => async () => {
    disposeListener()
    lifetime.abort(new Error('dsh-llm-net-retry plugin disposed'))
    await Promise.allSettled([...active])
  }, 'dsh-llm-net-retry: abort and drain active recovery')
}
