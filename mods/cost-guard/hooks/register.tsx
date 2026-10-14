import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import {
  addToDay,
  approxTokens,
  calibrate,
  calibrationFor,
  dayOf,
  estimate,
  explain,
  formatDuration,
  headline,
  limitsFor,
  modelKey,
  overLimits,
  parseDuration,
  parseLimits,
  pingAfterMs,
  pricesFor,
  status,
  totalsLine,
  ttlFrom,
  turnCostLine,
  usageUsd,
  warmArmed,
  warmEnded,
} from './estimate'
import type { CacheTtl, Calibration, Estimate, LimitChange, Limits } from './estimate'

const lastResponseAt = atom({ plugin: 'cost-guard', key: 'lastResponseAt' } as const, null)
const pending = atom({ plugin: 'cost-guard', key: 'pending' } as const, null)
const isPaused = atom({ plugin: 'cost-guard', key: 'isPaused' } as const, false)
const cacheCheck = atom({ plugin: 'cost-guard', key: 'cacheCheck' } as const, null)
const warmth = atom({ plugin: 'cost-guard', key: 'warm' } as const, null)
const turnCost = atom({ plugin: 'cost-guard', key: 'turnCost' } as const, null)
const lastModel = atom({ plugin: 'cost-guard', key: 'lastModel' } as const, null)

// Sending the same text again within this window counts as "send anyway".
const APPROVAL_MS = 10 * 60_000
const MINUTE = 60_000

// The cache lifetime measured from real responses, kept across sessions.
const MEASURED_TTL = 'measuredTtl'

// Each model's price calibration against Claude Code's own cost, kept across sessions.
const CALIBRATION = 'priceCalibration'

// What every session spent today, kept across sessions.
const SPENT_TODAY = 'spentToday'

// Adds what this session just spent to today's record; answers the session's
// today, every session's today, and since when the day is counted when it
// began partway through.
const addSpent = async ($: EngineInterface, usd: number): Promise<{ session: number; all: number; since?: number }> => {
  const sessionId = await $.session.id()
  const now = await $.clock.now()
  const today = addToDay(await $.store.get(SPENT_TODAY), dayOf(now), sessionId, usd, now)

  await $.store.set(SPENT_TODAY, today)

  return { session: today.sessions[sessionId] ?? 0, all: today.usd, since: today.since }
}

// Prompts a person sent. Task notifications, scheduled prompts and other
// plugins' prompts arrive with nobody to ask, so they pass.
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'unclassified'])

const OPTION_NAMES = ['maxContextPercent', 'maxTokens', 'maxUsd', 'cacheTtl', 'inputUsdPerMTok', 'showCost'] as const

const isShowingCost = (options: PluginOptions): boolean => String(options.showCost ?? 'on') === 'on'

// Claude Code caches for 5 minutes on an API key or a cloud provider and for
// an hour when signed in with a Claude account. Only presence is read.
const isApiOrCloud = async ($: EngineInterface): Promise<boolean> =>
  (await $.env.get('ANTHROPIC_API_KEY')) !== undefined ||
  (await $.env.get('CLAUDE_CODE_USE_BEDROCK')) === '1' ||
  (await $.env.get('CLAUDE_CODE_USE_VERTEX')) === '1' ||
  (await $.env.get('CLAUDE_CODE_USE_FOUNDRY')) === '1'

const cacheTtl = async ($: EngineInterface, options: PluginOptions): Promise<CacheTtl> => {
  const settings: Record<string, unknown> = await $.settings.read()
  const configured = (await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')) ?? settings.promptCacheTtl

  return ttlFrom(String(options.cacheTtl ?? 'auto'), configured, await $.store.get(MEASURED_TTL), await isApiOrCloud($))
}

const readCalibration = async ($: EngineInterface): Promise<Record<string, Calibration>> => {
  const stored = await $.store.get(CALIBRATION)

  return typeof stored === 'object' && stored !== null ? (stored as Record<string, Calibration>) : {}
}

const measure = async (
  $: EngineInterface,
  options: PluginOptions,
  text: string,
  now: number,
): Promise<{ est: Estimate; limits: Limits }> => {
  const usage = await $.session.usage()
  // The id the API reported for the last turn; before one, the session's model.
  const model = (await read($, lastModel)) ?? (await $.session.model())
  const last = await read($, lastResponseAt)
  const est = estimate({
    contextTokens: usage.context.tokens ?? 0,
    promptTokens: approxTokens(text),
    promptChars: text.length,
    gapMs: last === null ? null : now - last,
    ttl: await cacheTtl($, options),
    prices: pricesFor(model, Number(options.inputUsdPerMTok ?? 0), calibrationFor(await readCalibration($), model)),
  })

  return { est, limits: limitsFor(options, usage.context.window) }
}

type OptionName = (typeof OPTION_NAMES)[number]
type Overrides = Partial<Record<OptionName, number | string>>

// What /cost-guard set is kept in the plugin's own store, across sessions,
// and wins over settings.json; /cost-guard reset clears it.
const OVERRIDES = 'options'

const readOverrides = async ($: EngineInterface): Promise<Overrides> => {
  const stored = await $.store.get(OVERRIDES)

  return typeof stored === 'object' && stored !== null ? (stored as Overrides) : {}
}

const effectiveOptions = async ($: EngineInterface, options: PluginOptions): Promise<PluginOptions> => ({
  ...options,
  ...(await readOverrides($)),
})

const saveOverrides = async ($: EngineInterface, change: Overrides): Promise<void> => {
  await $.store.set(OVERRIDES, { ...(await readOverrides($)), ...change })
}

const optionName = (name: string): OptionName | undefined =>
  OPTION_NAMES.find(one => one.toLowerCase() === name.toLowerCase())

const setOption = async (
  $: EngineInterface,
  options: PluginOptions,
  name: string | undefined,
  raw: string | undefined,
): Promise<string> => {
  const usage = `Usage: /cost-guard set <name> <value>, where <name> is one of ${OPTION_NAMES.join(', ')}.`

  if (name === undefined) {
    const overrides = await readOverrides($)
    const current: PluginOptions = { ...options, ...overrides }

    return [
      usage,
      ...OPTION_NAMES.map(one => `  ${one} = ${String(current[one])}${one in overrides ? ' (set with /cost-guard)' : ''}`),
      '/cost-guard reset clears what /cost-guard set.',
    ].join('\n')
  }

  const field = optionName(name)

  if (field === undefined || raw === undefined) return usage
  if (field === 'cacheTtl') {
    if (!['auto', '5m', '1h'].includes(raw)) return 'cacheTtl takes auto, 5m or 1h.'
    await saveOverrides($, { cacheTtl: raw })

    return `cacheTtl = ${raw}. Applies from your next message.`
  }
  if (field === 'showCost') {
    if (!['on', 'off'].includes(raw)) return 'showCost takes on or off.'
    await saveOverrides($, { showCost: raw })

    return `showCost = ${raw}. Applies from your next message.`
  }

  const value = Number(raw)

  if (!Number.isFinite(value) || value < 0) return `${field} takes a number of 0 or more.`
  await saveOverrides($, { [field]: value })

  return `${field} = ${value}. Applies from your next message.`
}

// `/cost-guard $1 25% 10000`: each limit is read by its form.
const setLimits = async ($: EngineInterface, current: PluginOptions, change: LimitChange): Promise<string> => {
  const said: string[] = []
  const save: Overrides = {}

  if (change.maxUsd !== undefined) {
    save.maxUsd = change.maxUsd
    said.push(`dollar limit $${change.maxUsd}`)
  }
  if (change.maxContextPercent !== undefined) {
    save.maxContextPercent = change.maxContextPercent
    said.push(`token limit ${change.maxContextPercent}% of the context window`)
  }
  if (change.maxTokens !== undefined) {
    save.maxTokens = change.maxTokens
    said.push(
      change.maxTokens === 0
        ? 'token limit back to the percentage of the context window'
        : `token limit ${change.maxTokens} tokens (replaces the percentage; /cost-guard 0 brings it back)`,
    )
  } else if (change.maxContextPercent !== undefined && Number(current.maxTokens ?? 0) > 0) {
    // A token count replaces the percentage, so a new percentage clears it.
    save.maxTokens = 0
  }
  await saveOverrides($, save)

  return `Set: ${said.join('; ')}. Applies from your next message.`
}

// `on` and `off` may stand among the limits in any order. Setting a limit
// turns a paused guard back on, unless the same command says `off`.
const configure = async ($: EngineInterface, current: PluginOptions, words: readonly string[]): Promise<string> => {
  const toggle = words.map(word => word.toLowerCase()).filter(word => word === 'on' || word === 'off').pop()
  const limitWords = words.filter(word => !/^(on|off)$/i.test(word))
  const change = parseLimits(limitWords)

  if (typeof change === 'string') return change

  const wasPaused = await read($, isPaused)
  const willPause = toggle === 'off' || (toggle === undefined && limitWords.length === 0 && wasPaused)
  const said: string[] = []

  await update($, isPaused, () => willPause)

  if (willPause) {
    said.push('cost-guard is paused for this session; /cost-guard on resumes it.')
  } else if (wasPaused) {
    said.push('cost-guard was paused and is on again.')
  } else if (toggle === 'on') {
    said.push('cost-guard is on.')
  }
  if (limitWords.length > 0) {
    said.push(await setLimits($, current, change))
  }

  return said.join(' ')
}

// Keep-warm: while it is on, a ping shortly before the cache would expire reads
// the conversation back from the cache, which restarts the cache's timer.
const DEFAULT_WARM_MS = 2 * 60 * MINUTE
const PING_PROMPT = 'This is an automated keep-alive request. Reply with only the word OK.'

// Shorter than the narrowest ping window (45 seconds, for a 5-minute cache),
// so a tick always lands inside it; while keep-warm is off a tick is one read.
const TICK_MS = 15_000

// The module's own: a reload starts the ticker again from session.start.
let ticker: Timer | undefined
let isPinging = false

const stopWarm = async ($: EngineInterface, reason: string): Promise<string> => {
  const warm = await read($, warmth)

  await update($, warmth, () => null)
  $.ui.status(undefined)

  return warm === null ? reason : warmEnded(reason, warm)
}

const tick = async ($: EngineInterface, options: PluginOptions): Promise<void> => {
  const warm = await read($, warmth)

  if (warm === null || isPinging) return

  const now = await $.clock.now()

  if (now >= warm.until) {
    $.ui.toast(await stopWarm($, `cost-guard: keep-warm ended after ${formatDuration(warm.until - warm.since)}.`))

    return
  }

  $.ui.status(`cost-guard: keeping the cache warm, ${formatDuration(warm.until - now)} left`)

  const last = await read($, lastResponseAt)
  const { est } = await measure($, await effectiveOptions($, options), '', now)

  if (last === null || est.contextTokens === 0) return
  if (now - last > est.ttl.ms) {
    // Cold before keep-warm was on: the next message re-caches it, then pings start.
    if (last < warm.since) return

    $.ui.toast(await stopWarm($, 'cost-guard: the cache expired before keep-warm could ping (was the computer asleep?), so keep-warm stopped.'))

    return
  }
  if (now - last < pingAfterMs(est.ttl)) return

  isPinging = true
  try {
    const reply = await $.model.fork({ prompt: PING_PROMPT })

    if (!('usage' in reply)) {
      $.ui.toast(await stopWarm($, 'cost-guard: there is no conversation to keep warm, so keep-warm stopped.'))

      return
    }

    const cost = usageUsd(reply.usage, est.prices, est.ttl)
    const after = await $.clock.now()

    await addSpent($, cost)

    await update($, lastResponseAt, () => after)
    await update($, warmth, current => (current === null ? null : { ...current, pings: current.pings + 1, usd: current.usd + cost }))

    // A ping that read little back found the cache cold and paid to re-cache:
    // stop rather than pay that again.
    if (reply.usage.cache_read_input_tokens < est.contextTokens / 2) {
      $.ui.toast(await stopWarm($, 'cost-guard: the cache had already expired, so the last ping re-cached the conversation; keep-warm stopped.'))
    } else if (!reply.isAnswered && reply.reason === 'api-error') {
      $.ui.toast(await stopWarm($, `cost-guard: a keep-warm ping failed (HTTP ${reply.status}), so keep-warm stopped.`))
    }
  } finally {
    isPinging = false
  }
}

const startTicker = ($: EngineInterface, options: PluginOptions): void => {
  ticker ??= $.clock.every(TICK_MS, () => {
    void tick($, options).catch(() => undefined)
  })
}

// `/cost-guard warm [duration | off]`
const warmCommand = async ($: EngineInterface, options: PluginOptions, word: string | undefined): Promise<string> => {
  if (word?.toLowerCase() === 'off') {
    return (await read($, warmth)) === null ? 'Keep-warm is not on.' : stopWarm($, 'Keep-warm stopped.')
  }

  const durationMs = word === undefined ? DEFAULT_WARM_MS : parseDuration(word)

  if (durationMs === null) {
    return `"${word}" is not a duration. Write 2h, 90m or 1h30m, up to 24h; /cost-guard warm alone keeps it warm for 2h.`
  }

  startTicker($, options)

  const now = await $.clock.now()
  const current = await read($, warmth)
  const { est } = await measure($, await effectiveOptions($, options), '', now)

  await update($, warmth, () =>
    current === null ? { since: now, until: now + durationMs, pings: 0, usd: 0 } : { ...current, until: now + durationMs },
  )
  $.ui.status(`cost-guard: keeping the cache warm, ${formatDuration(durationMs)} left`)

  return warmArmed(est, durationMs, current !== null)
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cost-guard',
      description: 'Show what the next message would cost. $1, 25% or 10000 set the dollar, context-share or token limit (and turn the guard on); off/on pauses or resumes; warm keeps the cache warm during a break; show on adds each message\'s cost under the reply',
      argumentHint: '[$1] [25%] [10000] [on|off] | warm [2h|off] | show [on|off] | set <name> <value> | reset',
    })
    startTicker($, options)

    return next(e)
  })

  // Every main-loop response refreshes the cache and moves the context fill.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      const now = await $.clock.now()
      await update($, lastResponseAt, () => now)
    }

    return next(e)
  })

  // The session's cost as Claude Code totals it, when the main loop's turn starts.
  on('turn.start', async ($, e, next) => {
    const usd = (await $.session.usage()).cost?.usd

    await update($, turnCost, () => (usd === undefined ? null : { startUsd: usd, hasSubagent: false }))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // A subagent's cost lands in the same total, so its turn teaches no prices.
    if (e.agentId !== undefined) {
      await update($, turnCost, current => (current === null ? null : { ...current, hasSubagent: true }))

      return next(e)
    }
    if (e.usage === undefined) return next(e)

    const usage = e.usage
    const started = await read($, turnCost)
    const endUsd = (await $.session.usage()).cost?.usd

    await update($, lastModel, () => usage.model)
    await update($, turnCost, () => null)

    const current = await effectiveOptions($, options)

    // What Claude Code charged for the turn against the list price of its
    // tokens corrects the list prices: new models and price changes included.
    if (started !== null && !started.hasSubagent && endUsd !== undefined) {
      const table = await readCalibration($)
      const listed = usageUsd(usage, pricesFor(usage.model, 0), await cacheTtl($, current))
      // One entry per model, whichever context tag or dated snapshot reported it.
      const key = modelKey(usage.model)
      const learned = calibrate(table[key], endUsd - started.startUsd, listed)

      if (learned !== undefined) await $.store.set(CALIBRATION, { ...table, [key]: learned })
    }

    const prices = pricesFor(usage.model, Number(current.inputUsdPerMTok ?? 0), calibrationFor(await readCalibration($), usage.model))
    const ttl = await cacheTtl($, current)
    const totalUsd = started === null || endUsd === undefined ? undefined : endUsd - started.startUsd
    // Every turn counts toward the day, whether the line shows or not: what
    // Claude Code charged, subagents included, or else the estimate.
    const today = await addSpent($, totalUsd ?? usageUsd(usage, prices, ttl))

    // Two lines under the reply: what the message cost, reply included; then
    // the session's today and total, and every session's today. One log call
    // is one row, so each line is its own call.
    if (isShowingCost(current)) {
      $.ui.log(turnCostLine(usage, prices, ttl, started?.hasSubagent === true ? totalUsd : undefined))
      $.ui.log(totalsLine(endUsd, today.session, today.all, today.since))
    }

    const check = await read($, cacheCheck)

    if (check !== null) {
      // A turn after a long pause either re-wrote the whole conversation to
      // the cache (it had expired) or read it back (it had not).
      const isCold = e.usage.cache_creation_input_tokens >= check.contextTokens * 0.8

      if (!isCold && check.gapMs > 5 * MINUTE) await $.store.set(MEASURED_TTL, '1h')
      if (isCold && check.gapMs < 60 * MINUTE) await $.store.set(MEASURED_TTL, '5m')
      await update($, cacheCheck, () => null)
    }

    const now = await $.clock.now()
    await update($, lastResponseAt, () => now)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // A prompt typed during a turn joins a running turn, whose cache is warm.
    if (e.turnId !== undefined || !PERSON_ORIGINS.has(e.origin.kind)) {
      return next(e)
    }

    const now = await $.clock.now()
    const last = await read($, lastResponseAt)
    const contextTokens = (await $.session.usage()).context.tokens ?? 0

    if (last !== null && now - last > 5 * MINUTE && contextTokens >= 20_000) {
      await update($, cacheCheck, () => ({ gapMs: now - last, contextTokens }))
    }
    if (await read($, isPaused)) {
      return next(e)
    }

    const held = await read($, pending)

    if (held !== null && held.text === e.text && now < held.expiresAt) {
      await update($, pending, () => null)

      return next(e)
    }

    const text = [e.text, ...(e.context ?? [])].join('\n')
    const { est, limits } = await measure($, await effectiveOptions($, options), text, now)
    const over = overLimits(est, limits)

    if (over.length === 0) {
      if (held !== null) await update($, pending, () => null)

      return next(e)
    }

    const hasAttachments = (e.attachments?.length ?? 0) > 0
    await update($, pending, () => ({
      text: e.text,
      summary: headline(est),
      expiresAt: now + APPROVAL_MS,
      hasAttachments,
    }))
    // Put the message back in the box, so sending it again is one key.
    void $.prompt.fill({ text: e.text, mode: 'replace' }).catch(() => undefined)

    return { drop: explain(est, over, hasAttachments) }
  })

  on('command.run', { command: 'cost-guard' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    const arg = (words[0] ?? '').toLowerCase()

    if (arg === 'set') {
      return { text: await setOption($, options, words[1], words[2]) }
    }
    if (arg === 'warm') {
      return { text: await warmCommand($, options, words[1]) }
    }
    if (arg === 'show') {
      const word = (words[1] ?? '').toLowerCase()

      if (word !== 'on' && word !== 'off') {
        return { text: 'Usage: /cost-guard show on|off. On (the default), two lines under each reply show what the message cost and the totals so far.' }
      }
      await saveOverrides($, { showCost: word })

      return {
        text:
          word === 'on'
            ? 'From your next message, two lines under each reply show what the message cost (its input and Claude\'s reply) and the totals so far. /cost-guard show off turns them off.'
            : 'The cost lines under each reply are off. /cost-guard show on brings them back.',
      }
    }
    if (arg === 'reset') {
      await $.store.delete(OVERRIDES)

      return { text: 'Cleared what /cost-guard set; your settings.json values and the defaults apply again.' }
    }
    if (words.length > 0) {
      return { text: await configure($, await effectiveOptions($, options), words) }
    }

    const now = await $.clock.now()
    const current = await effectiveOptions($, options)
    const { est, limits } = await measure($, current, '', now)

    return { text: status(est, limits, await read($, isPaused), await read($, warmth), now, isShowingCost(current)) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const held = await read($, pending)

    if (held === null || e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const sendAnyway = async () => {
      const { value } = await $.state.get({ plugin: 'cost-guard', key: 'pending' })

      if (value === null || value === undefined) return
      await update($, pending, () => null)
      await $.prompt.fill({ text: '', mode: 'replace' }).catch(() => undefined)
      await $.prompt.submit({ text: value.text, asUser: true })
    }

    return (
      <Box flexDirection="column">
        <Text>{held.summary}</Text>
        <Box>
          <Button key="send" label="Send anyway" variant="primary" onPress={sendAnyway} />
          <Text> </Text>
          <Button key="drop" label="Don't send" onPress={() => update($, pending, () => null)} />
        </Box>
      </Box>
    )
  })
}
