# Claude-Mods

Mods for [Claude Code](https://code.claude.com/docs/en/plugins/mods/overview):
small plugins that change how Claude Code behaves. Install only the ones you
want ([how](#install)).

| Mod | What it does |
| --- | --- |
| [cost&#8209;guard](#cost-guard) | Stops an expensive message before it is sent, explains why and asks you first. Can also keep the cache warm during a break. |
| [read&#8209;aloud](#read-aloud) | Reads Claude's replies and plans aloud, whole or just what you selected, with a Stop button while it reads. |

## cost-guard

### Why

Every message re-sends the whole conversation so far. Claude Code keeps that
conversation in a **prompt cache**, which expires after a period with no
requests ([how long](#how-long-the-cache-stays-warm)). What the conversation
costs depends on whether the cache is still there:

- **Warm** (cache still there): the conversation is **read** from the cache,
  at a small fraction of the base input price.
- **Cold** (cache expired): the whole conversation is **written** to the cache
  again, at a premium over the base input price. Claude Code does this without
  a word.

Anthropic API list prices, in US dollars per million tokens (checked
2026-10-14 on the [pricing page](https://platform.claude.com/docs/en/about-claude/pricing)):

| Model | Base input | Warm: cache read | Cold: cache write, 1-hour cache | Cold: cache write, 5-minute cache | Cold costs this many times warm |
| --- | --- | --- | --- | --- | --- |
| Opus 5.5 | $4.00 | $0.20 (5% of base) | $8.00 (200% of base) | $5.00 (125% of base) | **40×** (1-hour), 25× (5-minute) |
| Sonnet 5.5 | $2.00 | $0.10 (5% of base) | $4.00 (200% of base) | $2.50 (125% of base) | **40×** (1-hour), 25× (5-minute) |
| Haiku 5.5, prompt up to 100,000 tokens | $0.10 | $0.01 (10% of base) | $0.20 (200% of base) | $0.125 (125% of base) | **20×** (1-hour), 12.5× (5-minute) |
| Haiku 5.5, prompt over 100,000 tokens | $0.50 | $0.05 (10% of base) | $1.00 (200% of base) | $0.625 (125% of base) | **20×** (1-hour), 12.5× (5-minute) |

The gap is wider than "a tenth" because both sides move away from the base
price: a warm read is **below** base (5% on Opus and Sonnet 5.5, 10% on
Haiku 5.5) and a cold write is **above** base (200% with the 1-hour cache). On
Opus 5.5 that is 200% ÷ 5% = 40.

#### How long the cache stays warm

Checked 2026-10-14 in the Claude Code docs
([cache lifetime](https://code.claude.com/docs/en/prompt-caching#cache-lifetime)):

| How you use Claude Code | The main conversation's cache lasts |
| --- | --- |
| Claude subscription, within your plan's usage | **1 hour** |
| Usage credits (extra usage), API key, or a cloud provider (Amazon Bedrock, Google Cloud, Microsoft Foundry) | **5 minutes** |

- The cache goes cold after that long **with no request**. Every request that
  reads the cache restarts the timer, so it stays warm while you keep working.
- The time counts from the **start** of the last request, not the end of
  Claude's reply. If a reply takes 4 minutes to stream, a 5-minute cache has
  about 1 minute left when it finishes.
- To choose it yourself, set `promptCacheTtl` in your settings or
  `CLAUDE_CODE_PROMPT_CACHE_TTL` to `5m` or `1h` (Claude Code 2.1.242 or
  later), for example `1h` with an API key. Cache writes are then priced at
  the 1-hour column above.
- This is the main conversation. Subagents get 5 minutes by default.

**Example:** a 400,000-token conversation on Opus 5.5, on a Claude
subscription within plan usage (1-hour cache). Your new text and Claude's reply are left out; they cost the
same either way.

| Your next message | The conversation is | Calculation | Costs about |
| --- | --- | --- | --- |
| While the cache is warm | Read from the cache | 400,000 × $0.20 / 1M | **$0.08** |
| After a lunch break, cache expired | Written to the cache again | 400,000 × $8.00 / 1M | **$3.20**, 40 times more |

The same conversation on Sonnet 5.5 costs $0.04 warm and $1.60 cold (also
40×); on Haiku 5.5, $0.02 warm and $0.40 cold (20×, at the over-100,000-token
prices).

That $3.20 is worth paying only if you still need the whole conversation. If
you don't, a new session is cheapest: it starts with only your instructions,
and you can still resume the old one. If the gist is enough, `/compact` cuts
the tokens in the session: it replaces the conversation with a short summary,
so every later message sends far fewer tokens. Compact before a break, while
the cache is still warm, and the summary itself costs little too.

A very large paste costs the same way. cost-guard checks every message before
it is sent. When it would cost more than your limit, it holds the message,
tells you why, and sends it only if you say so.

### How to use it

Nothing to do: once installed it guards every session with the defaults, **$1**
or **25% of the context window** at full price, whichever comes first. When a
message goes over, it goes back in the prompt box with an explanation
(shortened here):

> cost-guard held this message: its input would cost about $3.20 at Opus 5.5
> list price, over your limit ($3.20, limit $1.00). Why: the prompt cache has
> expired. The last model response was 2 h ago and the cache lasts 1h, so the
> whole conversation, 400,000 tokens, is written to the cache again. To send
> it anyway, send it again within 10 minutes or choose Send anyway. Cheapest
> is to start a new session: it begins with only your instructions, and you
> can still resume this one later. To keep going here, run /compact first: it
> replaces the conversation with a short summary, cutting the tokens in this
> session, so every later message, and every later re-cache, sends far fewer.

Then choose **Send anyway**, send the same text again, or **Don't send** and
either start a new session or `/compact` to shrink this one to a summary.

**What "25% of the context window" means.** It is not how full the context is.
It counts the tokens this one message pays **full price** for: with a warm
cache, only your new text; with a cold cache, the whole conversation plus your
new text. A message is held when that count reaches the limit (25% exactly
already holds). For a 260,000-token conversation (26%) on Opus 5.5, whose
1,000,000-token window makes the limit 250,000 tokens:

| Situation | Tokens at full price | Held by the 25% limit? |
| --- | --- | --- |
| Warm cache, short message | about 10 | No |
| Warm cache, 250,000-token paste | about 250,000 | Yes |
| Cold cache, short message | about 260,010 | Yes |

The `$1` limit is checked at the same time, and whichever is reached first
holds the message. On Opus 5.5 with a 1-hour cache, a cold message costs $8.00
per million tokens, so $1 is reached at about 125,000 tokens (12.5% of the
window): when the cache is cold, the dollar limit usually holds first. The
260,000-token cold message above costs about $2.08 and is held by both; the
same message with a warm cache costs about $0.05 and goes through.

**Going on a break, and want to keep this conversation?** Keep the cache warm
instead of paying to rebuild it:

```
/cost-guard warm 1h
```

It sends a tiny request about every 55 minutes (about $0.08 each at that size)
so the cache never expires, and stops by itself when the hour is up. While you
work, your own messages keep the cache warm and it sends nothing, so when you
are back, just keep typing. To stop it early:

```
/cost-guard warm off
```

**See what each message cost.** On by default: under each reply, one line says
what the message cost, and a second what this session spent today and in all,
and what every session spent today:

> This message cost about $0.10 (input $0.09, Claude's reply $0.01).
>
> Session today $1.20, total $4.10. Total today $12.37.

On the day you install it, today's figures count from the install and say so;
`python mods/cost-guard/tools/backfill-today.py --write` adds the rest of the
day from Claude Code's transcripts.

`/cost-guard show off` turns them off; `/cost-guard show on` brings them back.

**Commands:**

| You type | What happens |
| --- | --- |
| `/cost-guard` | Shows the limits, the cache state and what the next message would cost |
| `/cost-guard $1` | Holds any message whose input would cost more than $1 |
| `/cost-guard 25%` | Holds any message that pays full price for more than 25% of the context window |
| `/cost-guard 10k` | Holds any message that pays full price for more than 10,000 tokens |
| `/cost-guard $2 30% on` | Sets both limits and turns the guard on in one go |
| `/cost-guard off` / `on` | Pauses the guard for this session, or turns it back on |
| `/cost-guard warm` | Keeps the prompt cache warm for 2 hours while you are away |
| `/cost-guard warm 90m` | Keeps it warm for 90 minutes (`1h30m`, `1.5h`, up to `24h`) |
| `/cost-guard warm off` | Stops keeping it warm |
| `/cost-guard show on` / `off` | Adds two lines under each reply with what the message cost and the totals so far, or stops them (on by default) |
| `/cost-guard set maxUsd 0.5` | Changes one setting by name |
| `/cost-guard reset` | Clears what `/cost-guard` set, so your settings and the defaults ($1, 25%) apply |

### Try it: see it guard

Watch it work once, so you know it is guarding and what to expect. It takes
about 15 minutes, and step 4 puts everything back.

**1. A hold, right now.** Set a limit lower than any message costs:

```
/cost-guard $0.01
```

Send any message. It comes back in the prompt box with the explanation, and
**Send anyway** and **Don't send** above it. Choose either.

**2. The expired-cache hold, in about 5 minutes.** You don't have to wait an
hour for the cache to expire: tell cost-guard it lasts 5 minutes.

```
/cost-guard set cacheTtl 5m
```

Run `/cost-guard`. Its answer gives two costs, for example "A short message
now costs about $0.03 in input; once the cache is cold, about $0.71". Set a
limit between the two:

```
/cost-guard $0.5
```

Messages go through as usual. Then send nothing for more than 5 minutes, and
send a message: it is held with "the prompt cache has expired". On a Claude
subscription within plan usage the cache really lasts an hour, so this hold is a rehearsal, not a
real cost.

**3. Keep-warm.** With `cacheTtl 5m` still set:

```
/cost-guard warm 15m
```

Wait without sending. It sends a ping about every 4 minutes, and the status
line shows the time left. Run `/cost-guard` now and then: it counts the pings
so far and what they cost. `/cost-guard warm off` stops it.

**4. Back to normal.** Stop keep-warm if it is still on, then clear the
test settings:

```
/cost-guard warm off
```

```
/cost-guard reset
```

The [cost-guard guide](mods/cost-guard/README.md) covers how the cost is
estimated, every setting, and when keep-warm is worth it.

## read-aloud

### Why

A long plan or explanation is easier to take in by ear while you look at the
code it is about. read-aloud adds a button under each of Claude's replies that
reads it to you, using the voices your computer already has.

### How to use it

Under each reply:

- **🔊 Read message** reads the whole reply.
- **🔊 Read selection** reads only the text you selected. Select it, then
  press the button: no copying needed, and your clipboard is left as it was.

A plan Claude presents for approval gets **🔊 Read plan**. A spinner shows
until the voice starts, a second or two on Windows. While it reads, **■ Stop**
shows under the reply and above the prompt, and stops the voice at once.

| You type | What happens |
| --- | --- |
| `/read-aloud` | Reads the selected text, or else Claude's last reply |
| `/read-aloud plan` | Reads the current plan |
| `/read-aloud stop` | Stops reading |

It speaks with Windows' built-in voices, `say` on macOS, or `espeak` on Linux.
The [read-aloud guide](mods/read-aloud/README.md) covers choosing a voice and
speed, and what it reads and stores.

## Install

Run these in a terminal. A mod installed this way loads in every Claude Code
session, including the desktop app's Code tab.

1. Add the marketplace (once):

   ```bash
   claude plugin marketplace add https://sbli.ghe.com/OGs-Sandbox/Claude-Mods.git
   ```

2. Install a mod:

   ```bash
   claude plugin install cost-guard@claude-mods
   ```

   ```bash
   claude plugin install read-aloud@claude-mods
   ```

3. Start a new session, or run `/reload-plugins` in a running terminal session.

Inside a terminal session you can do the same with
`/plugin marketplace add https://sbli.ghe.com/OGs-Sandbox/Claude-Mods.git` and
`/plugin install cost-guard@claude-mods`. The desktop app's Code tab does not
offer `/plugin`, so install from a terminal there.

The marketplace is added by its git URL because it is hosted on
`sbli.ghe.com`; the `owner/repo` shorthand means github.com. Git uses your
usual credentials for `sbli.ghe.com`.

## Update

```bash
claude plugin marketplace update claude-mods
```

```bash
claude plugin update cost-guard@claude-mods
```

Then start a new session or run `/reload-plugins`.

## Remove

```bash
claude plugin uninstall cost-guard@claude-mods
```

## Mods are code: review before you install

A mod runs inside Claude Code without a sandbox. It can read your prompts, your
files and your environment. Each mod here lists what it reads and stores in its
README, and `claude plugin validate mods/<mod>` prints every Claude Code call a
mod makes.

## Add a mod

1. Create `mods/<name>/` with at least:

   ```
   .claude-plugin/plugin.json   { "name": "<name>", "version": "0.1.0", "description": "..." }
   hooks/hooks.json             { "modules": ["./register.tsx"] }
   hooks/register.tsx           export const register: Register = (on, options) => { ... }
   README.md                    what it does, with examples
   tests/<name>.test.ts         tests run by claude plugin test
   ```

   Claude Code can write one for you: ask it to "make a mod that ...".

2. List it in [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json):

   ```json
   { "name": "<name>", "source": "./mods/<name>", "description": "..." }
   ```

3. Add it to the table above.

4. Check it, then open a pull request:

   ```bash
   claude plugin validate .
   ```

   ```bash
   claude plugin validate mods/<name>
   ```

   ```bash
   claude plugin test mods/<name>
   ```

Raise a mod's `version` in its `plugin.json` with every change, so
`claude plugin update` picks it up.

To try a mod while you work on it, load it from its folder:

```bash
claude --plugin-dir mods/<name>
```
