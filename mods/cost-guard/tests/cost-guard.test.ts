import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import {
  calibrate,
  calibrationFor,
  estimate,
  formatDuration,
  limitsFor,
  parseDuration,
  parseLimits,
  pingAfterMs,
  pricesFor,
  ttlFrom,
} from '../hooks/estimate'

const MINUTE = 60_000
const OPUS = pricesFor('claude-opus-5-5', 0)
const FIVE = ttlFrom('auto', undefined, undefined, true)

describe('estimate', () => {
  test('a cold cache re-writes the whole conversation at the write price', () => {
    const est = estimate({
      contextTokens: 400_000,
      promptTokens: 100,
      promptChars: 400,
      gapMs: 30 * MINUTE,
      ttl: FIVE,
      prices: OPUS,
    })

    expect(est.isCold).toBe(true)
    expect(est.fullPriceTokens).toBe(400_100)
    // 400,000 tokens at $4 × 1.25 per million.
    expect(est.contextUsd).toBe(2)
  })

  test('a warm cache reads the conversation at the read price', () => {
    const est = estimate({
      contextTokens: 400_000,
      promptTokens: 100,
      promptChars: 400,
      gapMs: 2 * MINUTE,
      ttl: FIVE,
      prices: OPUS,
    })

    expect(est.isCold).toBe(false)
    expect(est.fullPriceTokens).toBe(100)
    expect(est.contextUsd).toBe(0.08)
  })

  test('with no reply seen, as after a resume, the cache counts as cold', () => {
    const est = estimate({ contextTokens: 400_000, promptTokens: 100, promptChars: 400, gapMs: null, ttl: FIVE, prices: OPUS })

    expect(est.isCold).toBe(true)
    expect(est.fullPriceTokens).toBe(400_100)
  })

  test('the cache lifetime: option, then setting, then measured, then the account default', () => {
    expect(ttlFrom('auto', undefined, undefined, false).label).toBe('1h')
    expect(ttlFrom('auto', undefined, undefined, true).label).toBe('5m')
    expect(ttlFrom('auto', undefined, '5m', false).label).toBe('5m')
    expect(ttlFrom('auto', '1h', '5m', true).label).toBe('1h')
    expect(ttlFrom('5m', '1h', '1h', false).label).toBe('5m')
  })

  test('the 1h lifetime keeps a 30-minute gap warm and doubles the write price', () => {
    const hour = ttlFrom('auto', '1h', undefined, true)

    expect(hour.writeMultiplier).toBe(2)
    expect(estimate({ contextTokens: 1, promptTokens: 1, promptChars: 4, gapMs: 30 * MINUTE, ttl: hour, prices: OPUS }).isCold).toBe(false)
  })

  test('the token limit defaults to 25% of the window; an absolute count replaces it', () => {
    expect(limitsFor({ maxContextPercent: 25, maxTokens: 0, maxUsd: 1 }, 1_000_000).maxTokens).toBe(250_000)
    expect(limitsFor({ maxContextPercent: 25, maxTokens: 80_000, maxUsd: 1 }, 1_000_000).maxTokens).toBe(80_000)
  })

  test('models are priced by family, and an override wins', () => {
    expect(pricesFor('claude-sonnet-5-5', 0).input).toBe(2)
    expect(pricesFor('Fable 5.1 (1M context)', 0).input).toBe(10)
    expect(pricesFor('claude-opus-5-5', 3).input).toBe(3)
  })

  test('durations are read as hours and minutes, up to a day', () => {
    expect(parseDuration('2h')).toBe(120 * MINUTE)
    expect(parseDuration('90m')).toBe(90 * MINUTE)
    expect(parseDuration('1h30m')).toBe(90 * MINUTE)
    expect(parseDuration('1.5h')).toBe(90 * MINUTE)
    expect(parseDuration('25h')).toBe(null)
    expect(parseDuration('soon')).toBe(null)
    expect(formatDuration(100 * MINUTE)).toBe('1h 40m')
  })

  test('keep-warm pings 5 minutes before a 1-hour cache expires, 45 seconds before a 5-minute one', () => {
    expect(pingAfterMs(ttlFrom('1h', undefined, undefined, false))).toBe(55 * MINUTE)
    expect(pingAfterMs(ttlFrom('5m', undefined, undefined, false))).toBe(4.25 * MINUTE)
  })

  test('calibration averages what Claude Code charged over the list-price estimate', () => {
    const first = calibrate(undefined, 1.25, 1)

    expect(first).toEqual({ ratio: 1.25, turns: 1 })
    expect(Math.round((calibrate(first, 1, 1)?.ratio ?? 0) * 1000)).toBe(1175)
    expect(calibrate(first, 0.002, 0.001)).toBe(first)
    expect(calibrate(first, 9, 1)).toBe(first)
  })

  test('a calibration scales the list prices, and an override still wins', () => {
    const scaled = pricesFor('claude-opus-5-5', 0, { ratio: 1.25, turns: 3 })

    expect(scaled.input).toBe(5)
    expect(scaled.label).toContain('× 1.25, calibrated')
    expect(pricesFor('claude-opus-5-5', 3, { ratio: 1.25, turns: 3 }).input).toBe(3)
  })

  test('a calibration is found by model id, with context tags and dates left out', () => {
    const table = { 'claude-opus-5-5': { ratio: 1.1, turns: 2 }, 'claude-opus-5': { ratio: 0.9, turns: 4 } }

    expect(calibrationFor(table, 'claude-opus-5-5[1m]')?.ratio).toBe(1.1)
    expect(calibrationFor(table, 'claude-opus-5-20260101')?.ratio).toBe(0.9)
    expect(calibrationFor(table, 'claude-sonnet-5-5')).toBe(undefined)
  })

  test('limits are read by their form', () => {
    expect(parseLimits(['$1'])).toEqual({ maxUsd: 1 })
    expect(parseLimits(['25%', '$0.5'])).toEqual({ maxContextPercent: 25, maxUsd: 0.5 })
    expect(parseLimits(['10000'])).toEqual({ maxTokens: 10_000 })
    expect(parseLimits(['80k'])).toEqual({ maxTokens: 80_000 })
    expect(parseLimits(['lots'])).toMatch(/is not a limit/)
    expect(parseLimits(['150%'])).toMatch(/at most 100%/)
  })
})

// The session's cost as Claude Code totals it; a test moves it as turns spend.
type Ledger = { usd: number }

const engine = (on: On, contextTokens: number, env: Readonly<Record<string, string>> = {}, ledger?: Ledger) => {
  const clock = mock.clock(on)
  const filled: string[] = []
  const toasts: string[] = []
  const logs: string[] = []
  // The session a test speaks for; a test switches it to play another session.
  const session = { id: 'session-1' }

  mock.env(on, env)
  mock.store(on)

  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: contextTokens, window: 1_000_000 },
      rateLimits: [],
      ...(ledger === undefined ? {} : { cost: { usd: ledger.usd } }),
    },
  }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: session.id }))
  on('settings.read', () => ({ value: {} }))
  on('prompt.fill', ($, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    logs.push(e.text)

    return { value: undefined }
  })

  return { clock, filled, toasts, logs, session }
}

// A session on a cloud provider, whose cache lasts 5 minutes.
const BEDROCK = { CLAUDE_CODE_USE_BEDROCK: '1' }

// A prompt as the person sends it from the prompt box.
const send = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

// The /cost-guard command as the person types it.
const command = ($: Engine, args: string) =>
  $.command.run({
    command: 'cost-guard',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

const replyWriting = (written: number) => ({
  answer: 'done',
  durationMs: 1000,
  isAborted: false,
  turnId: 'turn-1',
  reason: 'answer',
  usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: written },
}) as const

const reply = replyWriting(0)

describe('prompt.submit', () => {
  test('holds a message after the cache went cold, explains why on one line, and sends it when sent again', async ($, on) => {
    const { clock, filled } = engine(on, 400_000, BEDROCK)

    await $.turn.complete(reply)
    await clock.advance(30 * MINUTE)

    const held = await send($, 'keep going')

    expect(held.drop).toMatch(/The last model response was 30 min ago and the cache lasts 5m/)
    expect(held.drop).toMatch(/400,000 tokens/)
    expect(held.drop).not.toMatch(/\n/)
    expect(filled).toEqual(['keep going'])

    const sent = await send($, 'keep going')

    expect(sent.text).toBe('keep going')
  })

  test('with a Claude account the cache lasts an hour, so a 30-minute pause passes', async ($, on) => {
    const { clock } = engine(on, 400_000)

    await $.turn.complete(reply)
    await clock.advance(30 * MINUTE)

    expect((await send($, 'keep going')).text).toBe('keep going')
  })

  test('learns a 5-minute cache when a turn after a pause re-wrote the conversation', async ($, on) => {
    const { clock } = engine(on, 400_000)

    await $.turn.complete(reply)
    await clock.advance(10 * MINUTE)
    expect((await send($, 'first')).text).toBe('first')
    await $.turn.complete(replyWriting(400_000))
    await clock.advance(10 * MINUTE)

    const held = await send($, 'second')

    expect(held.drop).toMatch(/cache lasts 5m \(measured from your earlier responses\)/)
  })

  test('lets a small message through while the cache is warm', async ($, on) => {
    const { clock } = engine(on, 400_000, BEDROCK)

    await $.turn.complete(reply)
    await clock.advance(2 * MINUTE)

    expect((await send($, 'keep going')).text).toBe('keep going')
  })

  test('holds a very large message even with a warm cache', async ($, on) => {
    const { clock } = engine(on, 10_000)

    await $.turn.complete(reply)
    await clock.advance(MINUTE)

    const held = await send($, 'x'.repeat(1_200_000))

    expect(held.drop).toMatch(/your message is about 300,000 tokens/)
  })

  // A resumed session: the conversation is there, but no reply since the guard loaded.
  test('after a resume, holds a large conversation as a cold cache', async ($, on) => {
    engine(on, 213_000)

    const held = await send($, 'our findings were addressed')

    expect(held.drop).toMatch(/has not seen a model response since it loaded/)
    // 213,000 tokens re-cached at $8 per million (1-hour cache).
    expect(held.drop).toMatch(/213,000 tokens, is written to the cache again at \$8.00 per million tokens, about \$1.70/)
    expect(held.drop).toContain('Cheapest is to start a new session')
  })

  test('after a resume, a small conversation passes, and the first reply makes it warm', async ($, on) => {
    const { clock } = engine(on, 20_000)

    // 20,000 tokens at $8 per million is $0.16, under the $1 limit.
    expect((await send($, 'hello')).text).toBe('hello')
    await $.turn.complete(reply)
    await clock.advance(MINUTE)
    expect((await command($, '')).text).toMatch(/the cache is warm/)
  })

  test('after a resume, /cost-guard says the cache counts as cold', async ($, on) => {
    engine(on, 400_000)

    expect((await command($, '')).text).toMatch(/no model response seen since cost-guard loaded, so it counts the cache as cold/)
  })

  test('/cost-guard off lets everything through for the session', async ($, on) => {
    const { clock } = engine(on, 400_000, BEDROCK)
    on('command.register', ($, e) => ({ value: { command: e.name } }))

    await $.turn.complete(reply)
    await clock.advance(30 * MINUTE)
    await command($, 'off')

    expect((await send($, 'keep going')).text).toBe('keep going')
  })
})

// The options as `/cost-guard set` lists them, one `name = value` per line.
const listed = async ($: Engine): Promise<string> => (await command($, 'set')).text ?? ''

describe('/cost-guard limits', () => {
  test('$ sets dollars and % sets the context share, clearing a token count that would replace it', { options: { maxTokens: 80_000 } }, async ($, on) => {
    engine(on, 0)
    on('command.register', ($, e) => ({ value: { command: e.name } }))

    const done = await command($, '$0.75 20%')

    expect(done.text).toMatch(/dollar limit \$0.75; token limit 20% of the context window/)
    expect(await listed($)).toMatch(/maxUsd = 0.75 \(set with/)
    expect(await listed($)).toMatch(/maxContextPercent = 20 \(set with/)
    expect(await listed($)).toMatch(/maxTokens = 0 \(set with/)
  })

  test('a bare number sets the token limit, and the new limit holds the next message', async ($, on) => {
    const { clock } = engine(on, 20_000)
    on('command.register', ($, e) => ({ value: { command: e.name } }))

    await command($, '10000')
    expect(await listed($)).toMatch(/maxTokens = 10000 \(set with/)

    await $.turn.complete(reply)
    await clock.advance(MINUTE)
    expect((await send($, 'x'.repeat(48_000))).drop).toMatch(/limit 10,000/)
  })

  test('"$1 on" sets the limit and turns the guard on', async ($, on) => {
    const { clock } = engine(on, 400_000, BEDROCK)
    on('command.register', ($, e) => ({ value: { command: e.name } }))

    await command($, 'off')
    const done = await command($, '$1 on')

    expect(done.text).toMatch(/was paused and is on again/)
    expect(await listed($)).toMatch(/maxUsd = 1 \(set with/)

    await $.turn.complete(reply)
    await clock.advance(30 * MINUTE)
    expect((await send($, 'keep going')).drop).toMatch(/held this message/)
  })

  test('a limit alone turns a paused guard back on', async ($, on) => {
    engine(on, 0)
    on('command.register', ($, e) => ({ value: { command: e.name } }))

    await command($, 'off')

    expect((await command($, '25%')).text).toMatch(/was paused and is on again/)
  })

  test('"off" among limits saves them and keeps the guard paused', async ($, on) => {
    const { clock } = engine(on, 400_000, BEDROCK)
    on('command.register', ($, e) => ({ value: { command: e.name } }))

    const done = await command($, 'off $2')

    expect(done.text).toMatch(/paused for this session/)
    expect(await listed($)).toMatch(/maxUsd = 2 \(set with/)

    await $.turn.complete(reply)
    await clock.advance(30 * MINUTE)
    expect((await send($, 'keep going')).text).toBe('keep going')
  })

  test('a word that is neither a limit nor on/off changes nothing', async ($, on) => {
    engine(on, 0)
    on('command.register', ($, e) => ({ value: { command: e.name } }))

    await command($, 'off')

    expect((await command($, '$1 maybe')).text).toMatch(/"maybe" is not a limit/)
    expect(await listed($)).not.toMatch(/set with/)
    expect((await command($, '')).text).toMatch(/is paused/)
  })

  test('set writes a named option, refuses a bad value, and reset clears it', async ($, on) => {
    engine(on, 0)
    on('command.register', ($, e) => ({ value: { command: e.name } }))

    expect((await command($, 'set maxusd 0.5')).text).toMatch(/maxUsd = 0.5/)
    expect((await command($, 'set maxUsd lots')).text).toMatch(/takes a number/)
    expect((await command($, 'set cacheTtl 2h')).text).toMatch(/auto, 5m or 1h/)
    expect(await listed($)).toMatch(/maxUsd = 0.5 \(set with/)

    await command($, 'reset')
    expect(await listed($)).toMatch(/maxUsd = 1\n/)
  })
})

// A ping as the API answers it: the conversation read back from the cache,
// or, when the cache had expired, written to it again.
const forks = (on: On, isCold = false) => {
  const prompts: string[] = []

  on('model.fork', ($, e) => {
    prompts.push(e.prompt)

    return {
      value: {
        isAnswered: true as const,
        text: 'OK',
        usage: {
          input_tokens: 20,
          output_tokens: 5,
          cache_read_input_tokens: isCold ? 0 : 400_000,
          cache_creation_input_tokens: isCold ? 400_000 : 30,
        },
      },
    }
  })

  return prompts
}

// Hours of keep-warm ticks run through the clock one by one: more than the default 5 seconds on a busy machine.
const SLOW = { timeoutMs: 20_000 }

const start = async ($: Engine, on: On) => {
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true })
}

describe('/cost-guard warm', () => {
  test('pings shortly before the 1-hour cache expires, then ends on time with what it spent', SLOW, async ($, on) => {
    const { clock, toasts } = engine(on, 400_000)
    const pings = forks(on)
    await start($, on)

    await $.turn.complete(reply)
    expect((await command($, 'warm 2h')).text).toContain('Keeping the cache warm for 2h. During a break it pings about every 55m, each about $0.08')

    await clock.advance(54 * MINUTE)
    expect(pings.length).toBe(0)
    await clock.advance(2 * MINUTE)
    expect(pings.length).toBe(1)
    await clock.advance(55 * MINUTE)
    expect(pings.length).toBe(2)

    expect((await command($, '')).text).toContain('Keep-warm: on for 9m more; 2 pings so far, about $0.16')

    await clock.advance(10 * MINUTE)
    expect(pings.length).toBe(2)
    expect(toasts.at(-1)).toContain('keep-warm ended after 2h. It sent 2 pings, about $0.16')
    expect((await command($, '')).text).toMatch(/Keep-warm: off/)
  })

  test('with a 5-minute cache it pings inside the 45-second window, whatever the timing', async ($, on) => {
    const { clock, toasts } = engine(on, 400_000, BEDROCK)
    const pings = forks(on)
    await start($, on)

    // The last response lands 50 seconds after the ticker started, so the
    // window (4m15s to 5m after it) holds no whole minute of the ticker.
    await clock.advance(50_000)
    await $.turn.complete(reply)
    await command($, 'warm 1h')
    await clock.advance(6 * MINUTE)

    expect(pings.length).toBe(1)
    expect(toasts.join(' ')).not.toContain('stopped')
  })

  test('sends nothing while you keep working', SLOW, async ($, on) => {
    const { clock } = engine(on, 400_000)
    const pings = forks(on)
    await start($, on)

    await $.turn.complete(reply)
    await command($, 'warm 2h')
    for (let i = 0; i < 4; i += 1) {
      await clock.advance(30 * MINUTE)
      await $.turn.complete(reply)
    }

    expect(pings.length).toBe(0)
  })

  test('stops when a ping finds the cache already cold', SLOW, async ($, on) => {
    const { clock, toasts } = engine(on, 400_000)
    const pings = forks(on, true)
    await start($, on)

    await $.turn.complete(reply)
    await command($, 'warm 3h')
    await clock.advance(2 * 60 * MINUTE)

    expect(pings.length).toBe(1)
    expect(toasts.at(-1)).toMatch(/had already expired.*keep-warm stopped/)
  })

  test('warm off stops it, and a bad duration changes nothing', async ($, on) => {
    const { clock } = engine(on, 400_000)
    const pings = forks(on)
    await start($, on)

    await $.turn.complete(reply)
    expect((await command($, 'warm soon')).text).toMatch(/"soon" is not a duration/)
    await command($, 'warm 2h')
    expect((await command($, 'warm off')).text).toContain('Keep-warm stopped. It sent 0 pings')
    await clock.advance(60 * MINUTE)

    expect(pings.length).toBe(0)
  })

  test('a held message after a cold cache points to /cost-guard warm', async ($, on) => {
    const { clock } = engine(on, 400_000, BEDROCK)

    await $.turn.complete(reply)
    await clock.advance(30 * MINUTE)

    expect((await send($, 'keep going')).drop).toContain('Next time, /cost-guard warm keeps the cache warm while you are away, for about $1.13 an hour')
  })

  test('a held message after a cold cache suggests a new session, then /compact, never /clear', async ($, on) => {
    const { clock } = engine(on, 400_000, BEDROCK)

    await $.turn.complete(reply)
    await clock.advance(30 * MINUTE)

    const held = await send($, 'keep going')

    expect(held.drop).toContain('Cheapest is to start a new session')
    expect(held.drop).toContain('To keep going here, run /compact first')
    expect(held.drop).not.toContain('/clear')
  })
})

// A turn's tokens; at Opus 5.5 list prices with a 1-hour cache they cost
// (10 × $4 + 400,000 × $0.20 + 1,000 × $8 + 500 × $20) / 1M = $0.09804.
const turnUsage = {
  model: 'claude-opus-5-5',
  input_tokens: 10,
  output_tokens: 500,
  cache_read_input_tokens: 400_000,
  cache_creation_input_tokens: 1_000,
}
const LISTED_TURN_USD = 0.09804

describe('price calibration', () => {
  test('learns from what Claude Code charged and prices the next message with it', async ($, on) => {
    const ledger = { usd: 1 }
    const { clock } = engine(on, 400_000, {}, ledger)

    await $.turn.start({ text: 'go', turnId: 'turn-1' })
    ledger.usd += LISTED_TURN_USD * 1.25
    await $.turn.complete({ ...reply, usage: turnUsage })
    await clock.advance(2 * 60 * MINUTE)

    const held = await send($, 'keep going')

    // 400,000 tokens re-cached at $8 × 1.25 per million.
    expect(held.drop).toContain('about $4.00 at Opus 5.5 list price × 1.25, calibrated to Claude Code')
  })

  test('a turn in which a subagent ran teaches nothing', async ($, on) => {
    const ledger = { usd: 1 }
    const { clock } = engine(on, 400_000, {}, ledger)

    await $.turn.start({ text: 'go', turnId: 'turn-1' })
    await $.turn.complete({ ...reply, agentId: 'agent-1' })
    ledger.usd += LISTED_TURN_USD * 3
    await $.turn.complete({ ...reply, usage: turnUsage })
    await clock.advance(2 * 60 * MINUTE)

    expect((await send($, 'keep going')).drop).toContain('about $3.20 at Opus 5.5 list price,')
  })

  test('one model learns as one, whichever context tag or date its id carries', async ($, on) => {
    const ledger = { usd: 1 }
    const { clock } = engine(on, 400_000, {}, ledger)

    for (const model of ['claude-opus-5-5[1m]', 'claude-opus-5-5-20261001']) {
      await $.turn.start({ text: 'go', turnId: model })
      ledger.usd += LISTED_TURN_USD * 1.25
      await $.turn.complete({ ...reply, usage: { ...turnUsage, model } })
    }
    await clock.advance(2 * 60 * MINUTE)

    expect((await send($, 'keep going')).drop).toContain('over 2 turns')
  })
})

describe('cost line', () => {
  test('is on by default: the cost on one line, the totals on a second', async ($, on) => {
    const { logs } = engine(on, 400_000)

    await $.turn.complete({ ...reply, usage: turnUsage })

    // Input $0.08804, reply 500 × $20 / 1M = $0.01. With no session count
    // from Claude Code, the day adds the estimate and the session's total is left out.
    expect(logs[0]).toBe("This message cost about $0.10 (input $0.09, Claude's reply $0.01).")
    // A first install counts the day from now, and says so.
    expect(logs[1]).toMatch(/^Session today ≥ \$0\.10\. Total today ≥ \$0\.10 \(counted since \d\d:\d\d; tools\/backfill-today\.py adds the rest\)\.$/)
  })

  test('a day after a record of an earlier day is whole', async ($, on) => {
    const { clock, logs } = engine(on, 400_000)

    await $.turn.complete({ ...reply, usage: turnUsage })
    await clock.advance(24 * 60 * MINUTE)
    await $.turn.complete({ ...reply, usage: turnUsage })
    expect(logs.at(-1)).toBe('Session today $0.10. Total today $0.10.')
  })

  test('/cost-guard show off turns both lines off and show on brings them back', async ($, on) => {
    const { logs } = engine(on, 400_000)

    expect((await command($, 'show off')).text).toContain('The cost lines under each reply are off')
    await $.turn.complete({ ...reply, usage: turnUsage })
    expect(logs).toHaveLength(0)
    expect((await command($, '')).text).toContain('Cost lines: off')

    expect((await command($, 'show on')).text).toContain('two lines under each reply show what the message cost')
    await $.turn.complete({ ...reply, usage: turnUsage })
    expect(logs).toHaveLength(2)
    expect((await command($, 'show maybe')).text).toContain('Usage: /cost-guard show on|off')
  })

  test("adds a subagent's cost from Claude Code's own count", async ($, on) => {
    const ledger = { usd: 1 }
    const { logs } = engine(on, 400_000, {}, ledger)

    await $.turn.start({ text: 'go', turnId: 'turn-1' })
    await $.turn.complete({ ...reply, agentId: 'agent-1' })
    ledger.usd += 0.5
    await $.turn.complete({ ...reply, usage: turnUsage })

    expect(logs.slice(-2)).toEqual([
      "This message cost about $0.50 (input $0.09, Claude's reply $0.01, subagents $0.40).",
      expect.stringMatching(/^Session today ≥ \$0\.50, total \$1\.50\. Total today ≥ \$0\.50 \(counted since/),
    ])
  })

  test("adds the session's total over all its days, its today and every session's today", async ($, on) => {
    // The session already spent $1 on earlier days.
    const ledger = { usd: 1 }
    const { clock, logs, session } = engine(on, 400_000, {}, ledger)
    const turn = async (usd: number) => {
      await $.turn.start({ text: 'go', turnId: 'turn-1' })
      ledger.usd += usd
      await $.turn.complete({ ...reply, usage: turnUsage })
    }

    await turn(0.25)
    expect(logs.at(-1)).toMatch(/^Session today ≥ \$0\.25, total \$1\.25\. Total today ≥ \$0\.25 \(counted since/)

    // Another session, $5 over its earlier days, spends $2 today.
    session.id = 'session-2'
    ledger.usd = 5
    await turn(2)
    expect(logs.at(-1)).toMatch(/^Session today ≥ \$2\.00, total \$7\.00\. Total today ≥ \$2\.25 /)

    session.id = 'session-1'
    ledger.usd = 1.25
    await turn(0.5)
    expect(logs.at(-1)).toMatch(/^Session today ≥ \$0\.75, total \$1\.75\. Total today ≥ \$2\.75 /)

    // The next day both of today's figures start over, whole; the session's total does not.
    await clock.advance(24 * 60 * MINUTE)
    await turn(0.1)
    expect(logs.at(-1)).toBe('Session today $0.10, total $1.85. Total today $0.10.')
  })

  test("the day counts every turn while the lines are off, and a keep-warm ping's cost", { ...SLOW, options: { showCost: 'off' } }, async ($, on) => {
    const ledger = { usd: 1 }
    const { clock, logs } = engine(on, 400_000, {}, ledger)
    forks(on)
    await start($, on)

    // Charged at list price, so the calibration stays at × 1.
    await $.turn.start({ text: 'go', turnId: 'turn-1' })
    ledger.usd += LISTED_TURN_USD
    await $.turn.complete({ ...reply, usage: turnUsage })
    await command($, 'warm 1h')
    // One ping: (400,000 × $0.20 + 30 × $8 + 20 × $4 + 5 × $20) / 1M = $0.08042.
    await clock.advance(56 * MINUTE)
    await command($, 'show on')
    await $.turn.start({ text: 'go', turnId: 'turn-2' })
    ledger.usd += LISTED_TURN_USD
    await $.turn.complete({ ...reply, usage: turnUsage })

    // $0.09804 + $0.08042 + $0.09804.
    // Only the last turn, after show on, logged its two lines.
    expect(logs).toHaveLength(2)
    expect(logs.at(-1)).toMatch(/^Session today ≥ \$0\.28, total \$1\.20\. Total today ≥ \$0\.28 /)
  })
})
