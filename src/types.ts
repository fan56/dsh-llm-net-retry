import type { Branded } from '@deepseek-ai/dsh-brand'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'

/** Stable identity shared by every attempt in one request-step retry chain. */
export type RetryId = Branded<'RetryId'>

/**
 * Brand an implementation-minted retry-chain identity.
 * @param id - opaque retry identity.
 * @returns the same string, branded; no validation is performed.
 */
export function RetryId(id: string): RetryId {
  return id as RetryId
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable, non-surface record of one provider-routed retry scheduled after a failed request attempt. */
    'llm/retry': LlmRetryEventData
    /** Durable transition written after a retry wait succeeds and before the next request attempt starts. */
    'llm/retry-started': LlmRetryStartedEventData
  }
}

/**
 * Durable payload recorded before one net-retry wait. Shape-compatible with
 * dsh-llm-retry's `LlmRetryEventData` (normal mode) so every `llm/retry`
 * consumer — the TUI included — renders it without changes.
 */
export interface LlmRetryEventData {
  retryId: RetryId
  turn: number
  step: number
  provider: string
  mode: 'normal'
  policyKey: string
  retry: number
  maxRetries: number
  delayMs: number
  failure: LlmFailure
}

/** Durable transition recorded after one retry delay completes. */
export interface LlmRetryStartedEventData {
  retryId: RetryId
  turn: number
  step: number
  retry: number
}
