/** A message the guard held, waiting for the person to send it anyway or drop it. */
export type CostGuardPending = {
  text: string
  /** The explanation shown when the message was held. */
  summary: string
  /** Until when sending the same text again counts as approval, in `$.clock.now()` ms. */
  expiresAt: number
  hasAttachments: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'cost-guard': {
      /**
       * When the cache was last refreshed, by a main-loop response or a
       * keep-warm ping, in `$.clock.now()` ms; null before the first.
       */
      lastResponseAt: number | null
      pending: CostGuardPending | null
      /** Set by `/cost-guard off` for the rest of the session. */
      isPaused: boolean
      /**
       * A prompt sent after a pause longer than 5 minutes, whose turn will show
       * whether the cache outlived the pause; null when there is nothing to learn.
       */
      cacheCheck: { gapMs: number; contextTokens: number } | null
      /**
       * Keep-warm while it is on, for this session only: since and until when
       * (`$.clock.now()` ms), and the pings it sent and what they cost.
       */
      warm: { since: number; until: number; pings: number; usd: number } | null
      /**
       * The session's cost as Claude Code totals it when the main loop's turn
       * started, and whether a subagent's cost has joined it since.
       */
      turnCost: { startUsd: number; hasSubagent: boolean } | null
      /** The model id the API reported for the main loop's last turn. */
      lastModel: string | null
    }
  }
}
