# cost-guard

A Claude Code mod that stops a message **before** it is sent when that message
would cost more than you allow, explains why, and asks you to confirm.

Most of a message's cost is not the words you type. Every message re-sends the
whole conversation. While the prompt cache is warm, that costs almost nothing.
Once the cache has expired, the whole conversation is paid for again at full
price. cost-guard notices that moment, and very large pastes, and checks with
you first. Before a break, `/cost-guard warm` keeps the cache from expiring at
all, for a few cents an hour.

- [What it looks like](#what-it-looks-like)
- [How the cost is estimated](#how-the-cost-is-estimated)
- [The limits](#the-limits)
- [Commands](#commands)
- [Keeping the cache warm during a break](#keeping-the-cache-warm-during-a-break)
- [Seeing what each message cost](#seeing-what-each-message-cost)
- [Settings](#settings)
- [How it knows the cache lifetime](#how-it-knows-the-cache-lifetime)
- [What it checks and what it leaves alone](#what-it-checks-and-what-it-leaves-alone)
- [Limitations](#limitations)
- [Development](#development)

## What it looks like

You come back to a long conversation after lunch and type `keep going`.
cost-guard holds the message and shows:

> cost-guard held this message: its input would cost about $3.27 at Opus 5.5
> list price, over your limit (408,343 tokens at full price, limit 250,000 (25%
> of the window); $3.27, limit $1.00). Why: the prompt cache has expired. The
> last model response was 75 min ago and the cache lasts 1h (Claude account
> default), so the whole conversation, 408,340 tokens, is written to the cache
> again at $8.00 per million tokens, about $3.27. To send it anyway, send it
> again within 10 minutes (it is back in the box) or choose Send anyway.
> Cheapest is to start a new session: it begins with only your instructions,
> and you can still resume this one later. To keep going here, run /compact
> first: it replaces the conversation with a short summary, cutting the tokens
> in this session, so every later message, and every later re-cache, sends far
> fewer. Compacting reads the conversation once more, so it costs about as
> much as this message unless the cache is still warm, for example just before
> a break. Next time, /cost-guard warm keeps the cache warm while you are away,
> for about $0.09 an hour at this size. Claude's reply is not included.

A row above the prompt box sums it up and asks:

```
cost-guard held your message: about $3.27 in input, cold cache (408,340 tokens to re-cache).
[ Send anyway ]  [ Don't send ]
```

You then have five choices:

| You do | Result |
| --- | --- |
| Press Enter (your message is back in the box) within 10 minutes | It is sent |
| Choose **Send anyway** | It is sent |
| Choose **Don't send** | Nothing is spent |
| Choose **Don't send** and start a new session | The cheapest way on: the new session pays only for your instructions, and this one can still be resumed |
| Choose **Don't send**, run `/compact`, then send again | The session's tokens shrink to a summary. Compacting reads the conversation once more, about the cost of the held message, but every later message sends far fewer tokens |

`/compact` keeps the gist of the conversation and frees most of its tokens.
It is cheapest before a break, while the cache is still warm: on Opus 5.5 with
a 1-hour cache, reading a warm conversation costs 1/40 of re-caching a cold one
([prices below](#how-the-cost-is-estimated)).

A very large paste is held the same way, even while the cache is warm:

> cost-guard held this message: its input would cost about $2.40 at Opus 5.5
> list price, over your limit (300,000 tokens at full price, limit 250,000 (25%
> of the window); $2.40, limit $1.00). Why: your message is about 300,000
> tokens, written to the cache at $8.00 per million tokens, about $2.40. ...

## How the cost is estimated

Each message sends the whole conversation (the context) plus your new text.
What the context costs depends on the prompt cache:

| Cache state | When | The context is | Priced at |
| --- | --- | --- | --- |
| **Warm** | Within the cache lifetime of the last model response | Read from the cache | The cache read price, below the base input price |
| **Cold** | After the cache lifetime has passed | Written to the cache again | The cache write price, above the base input price |

Your new text is always written to the cache at the write price.

### Prices

cost-guard starts from Anthropic API list prices by model family, in US dollars
per million tokens (checked 2026-10-14 on the
[pricing page](https://platform.claude.com/docs/en/about-claude/pricing)):

| Model | Base input | Warm: cache read | Cold: cache write, 1-hour cache | Cold: cache write, 5-minute cache | Cold costs this many times warm |
| --- | --- | --- | --- | --- | --- |
| Fable 5.1 | $10.00 | $0.25 (2.5% of base) | $20.00 (200% of base) | $12.50 (125% of base) | 80× (1-hour), 50× (5-minute) |
| Opus 5.5 | $4.00 | $0.20 (5% of base) | $8.00 (200% of base) | $5.00 (125% of base) | 40× (1-hour), 25× (5-minute) |
| Sonnet 5.5 | $2.00 | $0.10 (5% of base) | $4.00 (200% of base) | $2.50 (125% of base) | 40× (1-hour), 25× (5-minute) |
| Haiku 5.5, prompt up to 100,000 tokens | $0.10 | $0.01 (10% of base) | $0.20 (200% of base) | $0.125 (125% of base) | 20× (1-hour), 12.5× (5-minute) |
| Haiku 5.5, prompt over 100,000 tokens | $0.50 | $0.05 (10% of base) | $1.00 (200% of base) | $0.625 (125% of base) | 20× (1-hour), 12.5× (5-minute) |

The last column is the cache write multiplier divided by the cache read
multiplier: on Opus 5.5 with a 1-hour cache, 200% ÷ 5% = 40. It is not 10×
because the warm side is below base and the cold side is above it.

cost-guard uses the up-to-100,000-token prices for Haiku 5.5 at any size
([Limitations](#limitations)).

### Worked example

A conversation of 408,340 tokens on Opus 5.5, and a 10-token message:

| Situation | Context | Your message (10 tokens) | Total input | Compared with warm |
| --- | --- | --- | --- | --- |
| Warm cache | 408,340 × $0.20 / 1M = $0.08 | under $0.01 | **about $0.08** | |
| Cold, 1-hour cache | 408,340 × $8.00 / 1M = $3.27 | under $0.01 | **about $3.27** | 40 times more |
| Cold, 5-minute cache | 408,340 × $5.00 / 1M = $2.04 | under $0.01 | **about $2.04** | 25 times more |

Older models of a family start from its newest one's prices, and a model it
does not recognise starts from Opus 5.5's.

### Prices keep themselves up to date

Claude Code keeps its own running cost for the session (the `/cost` total),
priced with the rates of the Claude Code release you run and any rates your
organization set. After each turn, cost-guard compares how much that total
grew with what its table says the same tokens cost, and keeps a correction per
model, across sessions. A new model or a price change is picked up within a few
turns, with no update to this mod.

For example, if a turn's tokens cost $0.098 at list price and Claude Code
charged $0.123, the correction is × 1.25. The next estimate then shows:

> cost-guard held this message: its input would cost about $4.00 at Opus 5.5
> list price × 1.25, calibrated to Claude Code's own cost over 1 turn, ...

Recent turns count most. A turn in which a subagent ran is skipped, because the
subagent's cost lands in the same total, and so is a turn whose figures are
implausible (a correction below × 0.2 or above × 5) or too small to measure.
`inputUsdPerMTok` replaces all of this with your own rate.

On a Claude subscription you are not billed per token, so read the dollar
figure as the API price of the same work: it still tells you how hard a message
hits your plan's usage limits.

## The limits

cost-guard holds a message when **either** limit is reached, so whichever is
lower wins.

| Limit | Default | What it compares |
| --- | --- | --- |
| Dollar limit | `$1` | The estimated input cost of this one message |
| Token limit | `25%` of the context window | The tokens this message pays **full price** for: a cold re-write of the context plus your message |

The token limit is about **one message's cost**, not about how full the context
is. It counts the tokens this message pays full price for: with a warm cache,
only your new text, because the context is read from the cache; with a cold
cache, the whole context plus your new text, because all of it is written to
the cache again. A message is held when either count **reaches** its limit, so
exactly 25% already holds.

For a 260,000-token conversation (26% of the window) on Opus 5.5, whose
1,000,000-token window makes the 25% limit 250,000 tokens:

| Situation | Tokens at full price | Held by the 25% limit? | Input cost (1-hour cache) | Held by the $1 limit? |
| --- | --- | --- | --- | --- |
| Warm cache, short message | about 10 | No | about $0.05 | No |
| Warm cache, 250,000-token paste | about 250,000 | Yes | about $2.05 | Yes |
| Cold cache, short message | about 260,010 | Yes | about $2.08 | Yes |

With the defaults on Opus 5.5 and a 1-hour cache, the dollar limit is usually
reached first when the cache is cold: a cold re-write costs $8.00 per million
tokens, so $1 is reached at about 125,000 tokens, 12.5% of the window.

On a 1,000,000-token model, 25% is 250,000 tokens; on a 200,000-token model it
is 50,000. A fixed token count can replace the percentage (see below).

## Commands

| You type | What it does |
| --- | --- |
| `/cost-guard` | Shows the limits, the cache state and what a message costs now |
| `/cost-guard $1` | Sets the dollar limit |
| `/cost-guard 25%` | Sets the token limit as a share of the context window |
| `/cost-guard 10000` or `/cost-guard 10k` | Sets a fixed token limit, which replaces the percentage |
| `/cost-guard 0` | Removes the fixed token limit, so the percentage applies again |
| `/cost-guard $0.75 20%` | Sets several limits at once, in any order |
| `/cost-guard off` | Pauses the guard for this session |
| `/cost-guard on` | Resumes it |
| `/cost-guard $1 on` | Sets a limit and resumes the guard |
| `/cost-guard $1 off` | Saves a limit but stays paused |
| `/cost-guard warm` | Keeps the cache warm for the next 2 hours ([below](#keeping-the-cache-warm-during-a-break)) |
| `/cost-guard warm 8h` | Keeps it warm for 8 hours; also `90m`, `1h30m`, up to `24h`. Run again to extend |
| `/cost-guard warm off` | Stops keeping it warm |
| `/cost-guard show on` | Adds two lines under each reply with what the message cost and the totals so far (the default, [below](#seeing-what-each-message-cost)) |
| `/cost-guard show off` | Stops adding them |
| `/cost-guard set` | Lists every setting and its value |
| `/cost-guard set cacheTtl 1h` | Sets any setting by name |
| `/cost-guard reset` | Clears what `/cost-guard` set, so `settings.json` and the defaults apply |

Setting a limit while the guard is paused turns it back on, unless the same
command says `off`.

`/cost-guard` on its own answers like this:

```
cost-guard is on (/cost-guard off pauses it for this session).
Limits: 250,000 (25% of the window) full-price tokens; $1.00.
Conversation: 408,340 tokens; last model response 2 min ago, so the cache is warm (lifetime 1h, Claude account default). Prices: Opus 5.5 list price.
A short message now costs about $0.08 in input; once the cache is cold, about $3.27.
Keep-warm: off. /cost-guard warm keeps the cache warm during a break, about $0.09 an hour at this size.
Cost lines: on, two lines under each reply show what the message cost and the totals so far. /cost-guard show off turns them off.
Change limits with /cost-guard $1, /cost-guard 25% or /cost-guard 10000 (tokens); /cost-guard set lists every option.
```

## Keeping the cache warm during a break

Reading the conversation from the cache restarts the cache's timer. So before
a break, `/cost-guard warm` has cost-guard send a tiny request over your
conversation shortly before the cache would expire: 5 minutes before for a
1-hour cache, 45 seconds before for a 5-minute one. Each request reads the
conversation from the cache and asks for a one-word reply. It is not added to
your conversation.

```
/cost-guard warm 2h
```

> Keeping the cache warm for 2h. During a break it pings about every 55m, each
> about $0.08 at this conversation's size, so at most about $0.25. While you
> work, your own messages keep the cache warm and no pings are sent. The status
> line shows the time left; /cost-guard warm off stops it.

While it is on, the status line shows `cost-guard: keeping the cache warm, 1h 40m
left`. When the time is up, a notice says what it spent:

> cost-guard: keep-warm ended after 2h. It sent 2 pings, about $0.16.

`/cost-guard` shows it too:

```
Keep-warm: on for 1h 40m more; 1 ping so far, about $0.08. /cost-guard warm off stops it.
```

### Is it worth it?

It pays off when the break is shorter than the point where the pings would
cost as much as one cold message. For a conversation of 408,340 tokens on Opus
5.5:

| Cache lifetime | Keep-warm costs | One message after the cache expired costs | Worth it for breaks up to |
| --- | --- | --- | --- |
| 1 hour (Claude account) | about $0.09 an hour | about $3.27 | about 36 hours |
| 5 minutes (API key, cloud provider) | about $1.15 an hour | about $2.04 | under 2 hours |

So with a Claude account it is cheap insurance for lunch, meetings or the
night; with a 5-minute cache, keep it to short breaks.

### When it stops by itself

- The time you gave runs out.
- A ping finds the cache already expired, for example after the computer slept:
  that ping paid to re-cache the conversation, and keep-warm stops rather than
  keep paying. A notice tells you.
- A ping fails with an API error, or the conversation was cleared.

If the cache had already expired when you ran `/cost-guard warm`, nothing is
sent until your next message re-caches it; keep-warm takes over from there.

Keep-warm lasts for the current session only and needs it to keep running:
nothing is sent while the computer sleeps or Claude Code is closed. On a Claude
subscription, pings use a little of your plan's usage rather than money.

## Seeing what each message cost

On by default. Under each of Claude's replies, a first line says what that
message cost: its input (the conversation and your text) and Claude's reply,
the reply's tool calls included. A second line gives what has been spent so far:

> This message cost about $0.10 (input $0.09, Claude's reply $0.01).
>
> Session today $1.20, total $4.10. Total today $12.37.

| Figure | What it counts |
| --- | --- |
| **Session today** | This session, since local midnight |
| **total** | This session over all its days, as Claude Code counts it (the `/cost` total). A session resumed over several days keeps adding to it |
| **Total today** | Every session, since local midnight |

Both of today's figures add up messages and keep-warm pings as Claude Code
charged them, subagents included. cost-guard keeps them as it goes, across
sessions, whether or not the line is shown, and starts them over at local
midnight. Two sessions finishing a message at the same moment can each miss the
other's, so read them as approximate. Where Claude Code keeps no count, the
session's `total` is left out and today's figures come from the estimates.

### The day you install it

cost-guard counts a day as it goes, so on the day you install it, today's
figures start at $0 and leave out everything spent before. The line says so:

> Session today ≥ $0.60, total $4.36. Total today ≥ $0.60 (counted since 11:55; tools/backfill-today.py adds the rest).

To count the whole day, run the backfill script once. It reads every
transcript Claude Code wrote today, prices each response the way cost-guard
does, and writes the day into cost-guard's store:

```bash
python mods/cost-guard/tools/backfill-today.py
```

That shows what it would write, beside what cost-guard has counted. Then write
it (the old store is kept as `.bak`):

```bash
python mods/cost-guard/tools/backfill-today.py --write
```

From your next message the line drops `≥` and "counted since". Run it between
messages: a message in progress is counted by the script and again when it
finishes. It needs Python 3.8 or later and nothing else. Run from an installed
copy, the script is under
`~/.claude/plugins/marketplaces/claude-mods/mods/cost-guard/tools/`.

The days after the first are whole, with one gap: a session that was already
open when you installed or updated cost-guard runs the old version, and adds
nothing, until it is restarted.

The line is for you only: it is not sent to Claude. It uses the same prices as
the estimates ([How the cost is estimated](#how-the-cost-is-estimated)), with
the calibration to Claude Code's own cost, which the line does not show. When a
subagent ran, its cost is added from Claude Code's own count, as
`subagents $0.40`. `/cost-guard show off` turns both lines off, and
`/cost-guard show on` brings them back; the choice is kept across sessions.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `maxContextPercent` | `25` | Token limit as a percentage of the context window. `0` turns it off. |
| `maxTokens` | `0` | Fixed token limit. Above `0`, it replaces the percentage. |
| `maxUsd` | `1` | Dollar limit. `0` turns it off. |
| `cacheTtl` | `auto` | Cache lifetime: `auto`, `5m` or `1h`. See below. |
| `showCost` | `on` | `on` adds two lines under each reply: what the message cost, then the session's and today's totals. `off` shows nothing. See [above](#seeing-what-each-message-cost). |
| `inputUsdPerMTok` | `0` | Your input price in US dollars per million tokens, used instead of the list prices and their calibration. `0` uses the calibrated list price of the session's model. |

Values come from three places, highest first:

1. What you set with `/cost-guard`. It is kept in the mod's own storage, across
   sessions, until `/cost-guard reset`.
2. `pluginConfigs` in `~/.claude/settings.json`:

   ```json
   {
     "pluginConfigs": {
       "cost-guard@claude-mods": {
         "options": { "maxContextPercent": 20, "maxUsd": 0.75 }
       }
     }
   }
   ```

   The key is `cost-guard@claude-mods` when installed from this marketplace and
   `cost-guard@inline` when loaded from a folder (`claude plugin list` shows
   it).
3. The defaults above.

## How it knows the cache lifetime

Claude Code keeps the main conversation's prompt cache for **1 hour** on a
Claude subscription within your plan's usage, and for **5 minutes** once the
subscription draws on usage credits, with an API key, or with a cloud provider
(checked 2026-10-14 in the Claude Code docs,
[cache lifetime](https://code.claude.com/docs/en/prompt-caching#cache-lifetime)).
Each request that reads the cache restarts the timer, counted from the
request's start. With `cacheTtl` on `auto`, cost-guard takes the first of:

1. `CLAUDE_CODE_PROMPT_CACHE_TTL` or the `promptCacheTtl` setting, when set.
2. The lifetime it **measured** from your own responses. After a pause longer
   than 5 minutes, it checks whether the next turn re-wrote the whole
   conversation (the cache had expired) or read it back (it had not), and
   remembers the answer across sessions.
3. 5 minutes when `ANTHROPIC_API_KEY` is set or Bedrock, Vertex or Foundry is
   in use, otherwise 1 hour.

It records the time after **every** model response, since each request
refreshes the cache. `/cost-guard` shows which lifetime it uses and where it
came from.

That time lives only as long as Claude Code's process. After you resume a
session or restart Claude Code (the desktop app included), cost-guard has seen
no response yet, so it counts the cache as **cold** until the first reply. A
resumed session is usually hours old, and its first message re-caches the
whole conversation. If you resume within the cache lifetime, a large
conversation may be held once when it did not need to be; send it again to go
ahead.

## What it checks and what it leaves alone

Checked: messages you send from the prompt box, from Remote Control and from
an SDK host.

Let through without a check:

- background task notifications, scheduled and `/loop` prompts, and prompts
  other plugins send, since nobody is there to answer;
- a message typed while Claude is working, which joins the running turn while
  the cache is warm;
- everything, while the guard is paused.

## Limitations

- It estimates **input** only. Claude's reply and the tool calls during the
  turn are extra.
- Until a model has a calibrated turn, its estimate uses the list-price table,
  so the first few messages on a new model or after a price change can be off.
  The correction scales a model's prices together, so a change in one rate
  alone (say, only cache reads) is matched on average, not exactly.
- Haiku 5.5 charges 5 times more per token once a prompt is over 100,000
  tokens. cost-guard's list prices use the lower rate, so a long Haiku 5.5
  conversation can be underestimated unless calibration corrects it.
- Your message's size is approximate, at about 4 characters per token.
- Switching models also makes the cache cold; cost-guard does not see that.
- **Send anyway** sends the text only. To keep pasted images, send the message
  again instead.
- If cost-guard itself fails, your message goes through rather than being
  blocked.

## Development

The mod is three files, plus its type contract, tests and one script:

```
.claude-plugin/plugin.json   manifest and settings (userConfig)
hooks/hooks.json             names the hooks module
hooks/register.tsx           the hooks (prompt.submit, turn.start, turn.complete, session.measure), the command, the band and keep-warm
hooks/estimate.ts            the cost arithmetic, price calibration, durations and every message text, free of Claude Code calls
types/index.d.ts             the session state the mod keeps
tests/cost-guard.test.ts     tests run against the engine
tools/backfill-today.py      counts the install day's earlier spending from the transcripts
```

Check and test it from the repository root:

```bash
claude plugin validate mods/cost-guard
```

```bash
claude plugin test mods/cost-guard
```

To try a change without installing it, start a session with the folder loaded:

```bash
claude --plugin-dir mods/cost-guard
```

## Credits

The keep-warm idea comes from [Cache Tax](https://github.com/karanb192/cache-tax)
by karanb192. cost-guard's version is written separately.
