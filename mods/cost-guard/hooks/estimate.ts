import type { PluginOptions } from 'claude-code'

/** Prices in US dollars per million tokens. */
export type Prices = {
  label: string
  input: number
  cacheRead: number
  output: number
}

// API list prices of the current models (2026-10). A family's older models
// are priced as its newest. The calibration below corrects them to what Claude
// Code itself charges; inputUsdPerMTok replaces them.
const OPUS: Prices = { label: 'Opus 5.5 list price', input: 4, cacheRead: 0.2, output: 20 }
const LIST: readonly (readonly [RegExp, Prices])[] = [
  [/fable|mythos/i, { label: 'Fable 5.1 list price', input: 10, cacheRead: 0.25, output: 50 }],
  [/opus/i, OPUS],
  [/sonnet/i, { label: 'Sonnet 5.5 list price', input: 2, cacheRead: 0.1, output: 10 }],
  [/haiku/i, { label: 'Haiku 5.5 list price', input: 0.1, cacheRead: 0.01, output: 0.5 }],
]

/**
 * How far the list prices are from what Claude Code charged for one model:
 * its cost over the list-price estimate of the same tokens, averaged over turns.
 */
export type Calibration = { ratio: number; turns: number }

export const pricesFor = (model: string, inputOverride: number, calibration?: Calibration): Prices => {
  if (inputOverride > 0) {
    // Every current family's output costs five times its input.
    return { label: 'your price override', input: inputOverride, cacheRead: inputOverride * 0.1, output: inputOverride * 5 }
  }

  const found = LIST.find(([pattern]) => pattern.test(model))
  const prices = found?.[1] ?? { ...OPUS, label: `Opus 5.5 list price (model "${model}" not recognised)` }

  if (calibration === undefined) return prices

  const { ratio, turns } = calibration

  return {
    label: `${prices.label} × ${ratio.toFixed(2)}, calibrated to Claude Code's own cost over ${turns} turn${turns === 1 ? '' : 's'}`,
    input: prices.input * ratio,
    cacheRead: prices.cacheRead * ratio,
    output: prices.output * ratio,
  }
}

/**
 * A model id without the suffixes Claude Code or a provider adds: a context
 * tag (`[1m]`) and a date (`-20260401`), so `claude-opus-5-5[1m]` is
 * `claude-opus-5-5` and stays apart from `claude-opus-5`.
 */
export const modelKey = (model: string): string =>
  model
    .toLowerCase()
    .replace(/\[.*?\]/g, '')
    .replace(/-\d{8}$/, '')
    .trim()

/** The calibration of a model, kept under its `modelKey`. */
export const calibrationFor = (table: Readonly<Record<string, Calibration>>, model: string): Calibration | undefined =>
  table[modelKey(model)]

/**
 * One turn's lesson: what Claude Code charged against the list-price estimate
 * of the same tokens. A turn too small to measure, or whose ratio is
 * implausible (another request's cost rode along), teaches nothing.
 */
export const calibrate = (previous: Calibration | undefined, chargedUsd: number, estimatedUsd: number): Calibration | undefined => {
  if (estimatedUsd < 0.01 || chargedUsd <= 0) return previous

  const ratio = chargedUsd / estimatedUsd

  if (ratio < 0.2 || ratio > 5) return previous
  if (previous === undefined) return { ratio, turns: 1 }

  // Recent turns count most, so a price change shows within a few turns.
  return { ratio: previous.ratio * 0.7 + ratio * 0.3, turns: previous.turns + 1 }
}

export type CacheTtl = { label: '5m' | '1h'; ms: number; writeMultiplier: number; source: string }

const isTtl = (value: unknown): value is '5m' | '1h' => value === '5m' || value === '1h'

/**
 * The main conversation's cache lifetime, first found of: the cacheTtl option,
 * the configured TTL (env var or promptCacheTtl), the lifetime measured from
 * earlier responses, and Claude Code's default (5m on an API key or a cloud
 * provider, 1h when signed in with a Claude account).
 */
export const ttlFrom = (option: string, configured: unknown, measured: unknown, isApiOrCloud: boolean): CacheTtl => {
  const [label, source]: ['5m' | '1h', string] = isTtl(option)
    ? [option, 'your cacheTtl option']
    : isTtl(configured)
      ? [configured, 'your promptCacheTtl setting']
      : isTtl(measured)
        ? [measured, 'measured from your earlier responses']
        : isApiOrCloud
          ? ['5m', 'API key or cloud provider default']
          : ['1h', 'Claude account default']

  return label === '1h'
    ? { label, source, ms: 60 * 60_000, writeMultiplier: 2 }
    : { label, source, ms: 5 * 60_000, writeMultiplier: 1.25 }
}

/**
 * How long after the last response keep-warm pings: shortly before the cache
 * expires, with room for a ping that is slow to start.
 */
export const pingAfterMs = (ttl: CacheTtl): number => ttl.ms - (ttl.label === '1h' ? 5 * 60_000 : 45_000)

/** What a call or turn costs: the four token counts at the model's prices. */
export const usageUsd = (
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
  },
  prices: Prices,
  ttl: CacheTtl,
): number =>
  (usage.input_tokens * prices.input +
    usage.cache_read_input_tokens * prices.cacheRead +
    usage.cache_creation_input_tokens * prices.input * ttl.writeMultiplier +
    usage.output_tokens * prices.output) /
  1_000_000

const MAX_WARM_MS = 24 * 60 * 60_000

/** Reads `2h`, `90m`, `1.5h` or `1h30m`, up to 24 hours; null for anything else. */
export const parseDuration = (word: string): number | null => {
  const match = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+)m)?$/i.exec(word)

  if (match === null || (match[1] === undefined && match[2] === undefined)) return null

  const ms = Math.round(Number(match[1] ?? 0) * 60 * 60_000 + Number(match[2] ?? 0) * 60_000)

  return ms > 0 && ms <= MAX_WARM_MS ? ms : null
}

/** `1h 40m`, `45m`, or `under a minute`. */
export const formatDuration = (ms: number): string => {
  const minutes = Math.round(ms / 60_000)

  if (minutes < 1) return 'under a minute'

  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60

  return hours === 0 ? `${rest}m` : rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

/** What keep-warm is doing, for `/cost-guard`. */
export type WarmState = { since: number; until: number; pings: number; usd: number }

export type LimitChange = { maxUsd?: number; maxContextPercent?: number; maxTokens?: number }

/**
 * Reads limits written the short way: `$1` is the dollar limit, `25%` the
 * share of the context window, and a bare count (`10000`, `80k`, `1.2m`) the
 * absolute token limit. Answers an error line for a word it cannot read.
 */
export const parseLimits = (words: readonly string[]): LimitChange | string => {
  const change: LimitChange = {}

  for (const word of words) {
    const dollars = /^\$(\d+(?:\.\d+)?)$/.exec(word)
    const percent = /^(\d+(?:\.\d+)?)%$/.exec(word)
    const tokens = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(word)

    if (dollars?.[1] !== undefined) {
      change.maxUsd = Number(dollars[1])
    } else if (percent?.[1] !== undefined) {
      if (Number(percent[1]) > 100) return `${word}: a percentage of the context window is at most 100%.`
      change.maxContextPercent = Number(percent[1])
    } else if (tokens?.[1] !== undefined) {
      const unit = tokens[2]?.toLowerCase()
      change.maxTokens = Math.round(Number(tokens[1]) * (unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : 1))
    } else {
      return `"${word}" is not a limit. Write $1 for dollars, 25% for a share of the context window, or 10000 (or 10k) for tokens.`
    }
  }

  return change
}

/** A rough count: about four characters per token for English text and code. */
export const approxTokens = (text: string): number => Math.ceil(text.length / 4)

export type Limits = { maxTokens: number; maxTokensLabel: string; maxUsd: number }

export const limitsFor = (options: PluginOptions, window: number): Limits => {
  const absolute = Number(options.maxTokens ?? 0)
  const percent = Number(options.maxContextPercent ?? 25)
  const maxUsd = Number(options.maxUsd ?? 1)

  if (absolute > 0) {
    return { maxTokens: absolute, maxTokensLabel: `${count(absolute)}`, maxUsd }
  }

  const fromPercent = Math.round((window * percent) / 100)

  return {
    maxTokens: fromPercent,
    maxTokensLabel: `${count(fromPercent)} (${percent}% of the window)`,
    maxUsd,
  }
}

export type Situation = {
  contextTokens: number
  promptTokens: number
  promptChars: number
  /**
   * Milliseconds since the last reply; null when the guard has not seen one,
   * as after a resume or a restart, when the cache is counted as cold.
   */
  gapMs: number | null
  ttl: CacheTtl
  prices: Prices
}

export type Estimate = Situation & {
  isCold: boolean
  /** Input tokens billed at the full write price: a cold re-write plus the message. */
  fullPriceTokens: number
  contextUsd: number
  promptUsd: number
  usd: number
}

export const estimate = (s: Situation): Estimate => {
  // With no reply seen since the guard loaded, the conversation came from a
  // resume or a restart, most likely hours old: assume the cache expired.
  const isCold = s.contextTokens > 0 && (s.gapMs === null || s.gapMs > s.ttl.ms)
  const writeRate = s.prices.input * s.ttl.writeMultiplier
  const contextUsd = (s.contextTokens * (isCold ? writeRate : s.prices.cacheRead)) / 1_000_000
  const promptUsd = (s.promptTokens * writeRate) / 1_000_000

  return {
    ...s,
    isCold,
    fullPriceTokens: (isCold ? s.contextTokens : 0) + s.promptTokens,
    contextUsd,
    promptUsd,
    usd: contextUsd + promptUsd,
  }
}

/** The limits the estimate reaches, each as a line; empty when it is within them. */
export const overLimits = (est: Estimate, limits: Limits): string[] => {
  const over: string[] = []

  if (limits.maxTokens > 0 && est.fullPriceTokens >= limits.maxTokens) {
    over.push(`${count(est.fullPriceTokens)} tokens at full price, limit ${limits.maxTokensLabel}`)
  }
  if (limits.maxUsd > 0 && est.usd >= limits.maxUsd) {
    over.push(`${usd(est.usd)}, limit ${usd(limits.maxUsd)}`)
  }

  return over
}

/** The one-line reason the band above the prompt shows. */
export const headline = (est: Estimate): string => {
  const why = [
    est.isCold ? `cold cache (${count(est.contextTokens)} tokens to re-cache)` : '',
    est.promptUsd >= est.contextUsd || !est.isCold ? `large message (~${count(est.promptTokens)} tokens)` : '',
  ].filter(Boolean)

  return `cost-guard held your message: about ${usd(est.usd)} in input, ${why.join(' and ')}.`
}

/**
 * The explanation shown when a message is held: one paragraph of plain
 * sentences, since the desktop app draws a hook's line breaks as `�`.
 */
export const explain = (est: Estimate, over: readonly string[], hasAttachments: boolean): string => {
  const writeRate = usd(est.prices.input * est.ttl.writeMultiplier)
  const sentences = [
    `cost-guard held this message: its input would cost about ${usd(est.usd)} at ${est.prices.label}, over your limit (${over.join('; ')}).`,
  ]

  if (est.isCold && est.gapMs === null) {
    sentences.push(
      'Why: cost-guard has not seen a model response since it loaded, as after resuming a session or restarting Claude Code, ' +
        `so it counts the prompt cache as expired (it lasts ${est.ttl.label}, ${est.ttl.source}). ` +
        `If it has, the whole conversation, ${count(est.contextTokens)} tokens, is written to the cache again at ${writeRate} per million tokens, about ${usd(est.contextUsd)}.`,
    )
    if (est.promptUsd >= est.usd / 10) {
      sentences.push(`Your message adds about ${count(est.promptTokens)} tokens (${usd(est.promptUsd)}).`)
    }
  } else if (est.isCold) {
    sentences.push(
      `Why: the prompt cache has expired. The last model response was ${ago(est.gapMs ?? 0)} ago and the cache lasts ${est.ttl.label} (${est.ttl.source}), ` +
        `so the whole conversation, ${count(est.contextTokens)} tokens, is written to the cache again at ${writeRate} per million tokens, about ${usd(est.contextUsd)}.`,
    )
    if (est.promptUsd >= est.usd / 10) {
      sentences.push(`Your message adds about ${count(est.promptTokens)} tokens (${usd(est.promptUsd)}).`)
    }
  } else {
    sentences.push(
      `Why: your message is about ${count(est.promptTokens)} tokens, written to the cache at ${writeRate} per million tokens, about ${usd(est.promptUsd)}.`,
    )
  }

  sentences.push(
    hasAttachments
      ? 'To send it anyway, re-attach any images and send it again within 10 minutes, or choose Send anyway, which sends the text only.'
      : 'To send it anyway, send it again within 10 minutes (it is back in the box) or choose Send anyway.',
  )
  if (est.isCold) {
    sentences.push(
      // Compacting reads the conversation to summarize it, so on a cold cache
      // it costs about as much as this message; a new session costs neither.
      'Cheapest is to start a new session: it begins with only your instructions, and you can still resume this one later.',
      'To keep going here, run /compact first: it replaces the conversation with a short summary, cutting the tokens in this session, so every later message, and every later re-cache, sends far fewer.',
      'Compacting reads the conversation once more, so it costs about as much as this message unless the cache is still warm, for example just before a break.',
      `Next time, /cost-guard warm keeps the cache warm while you are away, for about ${usd(warmUsdPerHour(est))} an hour at this size.`,
    )
  }
  sentences.push("Claude's reply is not included.")

  return sentences.join(' ')
}

/**
 * The line under a reply while `showCost` is on: what the message cost, its
 * input (the conversation and your text) and Claude's reply, at the prices the
 * estimates use. `totalUsd`, Claude Code's own count for the turn, is given when
 * a subagent ran, whose tokens the turn's usage leaves out.
 */
export const turnCostLine = (usage: Parameters<typeof usageUsd>[0], prices: Prices, ttl: CacheTtl, totalUsd?: number): string => {
  const inputUsd = usageUsd({ ...usage, output_tokens: 0 }, prices, ttl)
  const replyUsd = (usage.output_tokens * prices.output) / 1_000_000
  const mainUsd = inputUsd + replyUsd
  const subagentUsd = totalUsd === undefined ? 0 : Math.max(0, totalUsd - mainUsd)
  const parts = [`input ${usd(inputUsd)}`, `Claude's reply ${usd(replyUsd)}`, subagentUsd > 0 ? `subagents ${usd(subagentUsd)}` : '']

  return `This message cost about ${usd(mainUsd + subagentUsd)} (${parts.filter(Boolean).join(', ')}).`
}

/**
 * What was spent on one local day, kept across sessions: in all, and by each
 * session that spent on it, under its id. `since`, in `$.clock.now()` ms, is
 * when counting began on a day cost-guard was installed partway through, so
 * the figures leave out what was spent before; absent, the day is whole.
 */
export type DaySpend = { day: string; usd: number; sessions: Record<string, number>; since?: number }

const pad = (n: number): string => String(n).padStart(2, '0')

/** The local day `now` falls on, as `2026-10-14`. */
export const dayOf = (now: number): string => {
  const date = new Date(now)

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The local time `ms` falls on, as `11:55`. */
export const clockTime = (ms: number): string => {
  const date = new Date(ms)

  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const isDaySpend = (value: unknown): value is DaySpend =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as DaySpend).day === 'string' &&
  typeof (value as DaySpend).usd === 'number' &&
  typeof (value as DaySpend).sessions === 'object' &&
  (value as DaySpend).sessions !== null

/**
 * The day once a session spends `usd` more, at `now`. A new day starts from
 * zero, so the record holds only the sessions that spent today. With no record
 * at all, cost-guard was just installed: the day counts from `now`, and says so.
 * After a record of an earlier day, cost-guard was counting at midnight, so the
 * new day is whole.
 */
export const addToDay = (spent: unknown, day: string, sessionId: string, usd: number, now: number): DaySpend => {
  const same: DaySpend =
    isDaySpend(spent) && spent.day === day ? spent : spent === undefined ? { day, usd: 0, sessions: {}, since: now } : { day, usd: 0, sessions: {} }
  const added = Math.max(0, usd)

  return {
    ...same,
    usd: same.usd + added,
    sessions: { ...same.sessions, [sessionId]: (same.sessions[sessionId] ?? 0) + added },
  }
}

/**
 * The totals after the cost line: the session's today, its total over all its
 * days as Claude Code counts it (left out where it keeps no count), and every
 * session's today. On a day counted from `since`, both of today's figures are
 * at least what they show, and the line says from when.
 */
export const totalsLine = (sessionUsd: number | undefined, sessionTodayUsd: number, todayUsd: number, since?: number): string => {
  const atLeast = since === undefined ? '' : '≥ '

  return (
    `Session today ${atLeast}${usd(sessionTodayUsd)}${sessionUsd === undefined ? '' : `, total ${usd(sessionUsd)}`}. ` +
    `Total today ${atLeast}${usd(todayUsd)}${since === undefined ? '' : ` (counted since ${clockTime(since)}; tools/backfill-today.py adds the rest)`}.`
  )
}

/** What `/cost-guard` answers with no argument. */
export const status = (
  est: Estimate,
  limits: Limits,
  isPaused: boolean,
  warm: WarmState | null,
  now: number,
  showCost: boolean,
): string => {
  const cache =
    est.gapMs === null
      ? `no model response seen since cost-guard loaded, so it counts the cache as cold (lifetime ${est.ttl.label}, ${est.ttl.source})`
      : `last model response ${ago(est.gapMs)} ago, so the cache is ${est.isCold ? 'cold' : 'warm'} (lifetime ${est.ttl.label}, ${est.ttl.source})`
  const cold = estimate({ ...est, gapMs: est.ttl.ms + 1 })
  const keepWarm =
    warm === null
      ? `Keep-warm: off. /cost-guard warm keeps the cache warm during a break, about ${usd(warmUsdPerHour(est))} an hour at this size.`
      : `Keep-warm: on for ${formatDuration(warm.until - now)} more; ${warm.pings} ping${warm.pings === 1 ? '' : 's'} so far, about ${usd(warm.usd)}. /cost-guard warm off stops it.`

  return [
    `cost-guard is ${isPaused ? 'paused (/cost-guard on resumes it)' : 'on (/cost-guard off pauses it for this session)'}.`,
    `Limits: ${limits.maxTokens > 0 ? `${limits.maxTokensLabel} full-price tokens` : 'no token limit'}; ${limits.maxUsd > 0 ? `${usd(limits.maxUsd)}` : 'no dollar limit'}.`,
    `Conversation: ${count(est.contextTokens)} tokens; ${cache}. Prices: ${est.prices.label}.`,
    `A short message now costs about ${usd(est.usd)} in input; once the cache is cold, about ${usd(cold.usd)}.`,
    keepWarm,
    showCost
      ? 'Cost lines: on, two lines under each reply show what the message cost and the totals so far. /cost-guard show off turns them off.'
      : 'Cost lines: off. /cost-guard show on adds two lines under each reply with what the message cost and the totals so far.',
    'Change limits with /cost-guard $1, /cost-guard 25% or /cost-guard 10000 (tokens); /cost-guard set lists every option.',
  ].join('\n')
}

/** What keeping the cache warm costs an idle hour at this conversation's size. */
export const warmUsdPerHour = (est: Estimate): number =>
  ((est.contextTokens * est.prices.cacheRead) / 1_000_000) * (3_600_000 / pingAfterMs(est.ttl))

/** What `/cost-guard warm` answers once keep-warm is on. */
export const warmArmed = (est: Estimate, durationMs: number, isExtended: boolean): string => {
  const every = pingAfterMs(est.ttl)
  const ping = (est.contextTokens * est.prices.cacheRead) / 1_000_000
  const sentences = [
    `${isExtended ? 'Keep-warm extended' : 'Keeping the cache warm'} for ${formatDuration(durationMs)}.`,
    `During a break it pings about every ${formatDuration(every)}, each about ${usd(ping)} at this conversation's size, so at most about ${usd(ping * Math.ceil(durationMs / every))}.`,
    'While you work, your own messages keep the cache warm and no pings are sent.',
    'The status line shows the time left; /cost-guard warm off stops it.',
  ]

  if (est.isCold && est.gapMs === null) {
    sentences.push('No model response seen since cost-guard loaded, so nothing is sent until your next message: keep-warm starts from there.')
  } else if (est.isCold) {
    sentences.push('The cache has already expired: your next message re-caches it, and keep-warm starts from there.')
  }

  return sentences.join(' ')
}

/** The toast and answer when keep-warm ends, with what it spent. */
export const warmEnded = (reason: string, warm: WarmState): string =>
  `${reason} It sent ${warm.pings} ping${warm.pings === 1 ? '' : 's'}, about ${usd(warm.usd)}.`

const count = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

const usd = (n: number): string => (n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`)

const ago = (ms: number): string => {
  const minutes = Math.round(ms / 60_000)

  if (minutes < 1) return 'under a minute'
  if (minutes < 120) return `${minutes} min`

  return `${Math.round(minutes / 60)} h`
}
