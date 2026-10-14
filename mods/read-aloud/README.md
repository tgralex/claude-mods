# read-aloud

A Claude Code mod that reads Claude's replies and plans aloud: a whole reply,
or just the part you selected. While it reads, a **Stop** button stops it at
once.

To install it, add this repository's marketplace as the
[main README](../../README.md#install) shows, then:

```bash
claude plugin install read-aloud@claude-mods
```

- [What it looks like](#what-it-looks-like)
- [Commands](#commands)
- [Settings](#settings)
- [How it speaks](#how-it-speaks)
- [What it reads and stores](#what-it-reads-and-stores)
- [Limitations](#limitations)
- [Development](#development)

## What it looks like

Under each of Claude's replies:

```
● Here is the plan: ...

  🔊 Read message   🔊 Read selection
```

- **🔊 Read message** reads that reply.
- **🔊 Read selection** reads only the text you selected. Select it with the
  mouse, then press the button. No copying needed.
  - **In the desktop app**, the app does not tell mods what is selected, so
    read-aloud copies the selection itself: it presses Ctrl+C (Cmd+C on a
    Mac) in the app, reads what that copied, and puts your clipboard back as
    it was. With nothing selected, it says so rather than read what you
    copied before.
  - **In a terminal**, select the text in the fullscreen layout. There
    read-aloud never presses Ctrl+C, since that would interrupt Claude.

When Claude presents a plan to approve, its row gets **🔊 Read plan**.

From the press until the voice starts, a spinner shows with "Starting to
read ...". On Windows that takes a second or two, while PowerShell loads its
voice, and Read selection adds the time to copy the selection. Then the
buttons under the reply become **■ Stop**, and a band above the prompt shows
what is being read with its own **■ Stop** button, so you can stop it wherever
you have scrolled to:

```
🔊 Reading the message aloud  [ ■ Stop ]
```

Stop works while it is still starting, too.

Starting another reading stops the one before it. Only one reads at a time.

Markdown is read as sentences: headings, list items and table rows each get a
pause, and symbols such as `**`, `#` and `|` are left out. Links are read by
their text, and a bare address as "a link". Code blocks are announced as
"Code block skipped" unless you turn on `readCode`.

## Commands

| You type | What happens |
| --- | --- |
| `/read-aloud` | Reads the selected text, or else Claude's last reply |
| `/read-aloud selection` | Reads the selected text, in a fullscreen terminal (in the desktop app, use the button) |
| `/read-aloud last` | Reads Claude's last reply |
| `/read-aloud plan` | Reads the current plan from plan mode |
| `/read-aloud stop` | Stops reading |

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `voice` | empty | The system voice's exact name: `Microsoft Zira Desktop` or `Microsoft David Desktop` on Windows, `Samantha` on macOS. Empty uses the system's default voice. |
| `speed` | `100` | How fast to read, in percent: `150` is half again as fast, `75` slower. From `30` to `300`. |
| `readCode` | `false` | Read the contents of code blocks too. |

Set them in `~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "read-aloud@claude-mods": {
      "options": { "voice": "Microsoft Zira Desktop", "speed": 120 }
    }
  }
}
```

The key is `read-aloud@claude-mods` when installed from this marketplace and
`read-aloud@inline` when loaded from a folder.

To list the voices on Windows, run this in PowerShell:

```powershell
Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices().VoiceInfo.Name
```

On macOS, `say -v '?'` lists them.

## How it speaks

It uses the speech synthesizer your computer already has, so it needs no
setup, account or network:

| Platform | Program |
| --- | --- |
| Windows | Windows PowerShell with the built-in `System.Speech` voices |
| macOS | `say` |
| Linux | `espeak-ng` or `espeak`, when installed |
| Anything else | Claude Code's own speech, `$.audio.speak` |

The text goes to the program on its standard input, never on its command line.
**Stop** ends the program, so the voice stops mid-word. With Claude Code's own
speech (Linux without espeak), it reads a few sentences at a time and stops at
the end of the current ones.

## What it reads and stores

- It reads the text of a reply or plan only when you press a button or run
  `/read-aloud`, and the selection only then too.
- Read selection in the desktop app uses your clipboard for a moment: it
  copies the selection, reads it and puts back what the clipboard held. On
  Windows, clipboard history (Win+V) keeps the copied selection as an entry.
- To find the plan, it notes the path of the plan file that plan mode names,
  and reads that file when you ask for the plan.
- The text is passed only to the speech program on your own computer. Nothing
  is sent anywhere else.
- It keeps two values for the session: what is being read now, and the plan
  file's path. Nothing is kept across sessions.

## Limitations

- One reading is at most 20,000 characters, about 20 minutes of speech. For a
  longer reply, select the part you want.
- `/read-aloud selection` cannot read a selection in the desktop app: typing
  the command moves the focus to the prompt box. Use the button.
- In a terminal outside the fullscreen layout, Read selection has no
  selection to read, except on Linux, where it reads the primary selection
  (`wl-paste`, `xclip` or `xsel`).
- On macOS, copying the selection needs Accessibility access for Claude
  (System Settings, Privacy & Security, Accessibility). Restoring the
  clipboard there keeps its text only. read-aloud has not been tried on a Mac.
- A reply split by tool calls has a button under each part, and each reads its
  own part. `/read-aloud last` reads the whole last reply.
- On Linux without `espeak-ng` or `espeak`, Stop waits for the sentences being
  spoken to end.

## Development

```
.claude-plugin/plugin.json   manifest and settings (userConfig)
hooks/hooks.json             names the hooks module
hooks/register.tsx           the buttons, the Stop band, the command and the reading itself
hooks/speech.ts              markdown to speech and each platform's speech command, free of Claude Code calls
types/index.d.ts             the session state the mod keeps
tests/read-aloud.test.ts     tests run against the engine, with a fake speech program
```

Check and test it from the repository root:

```bash
claude plugin validate mods/read-aloud
```

```bash
claude plugin test mods/read-aloud
```

To try a change without installing it:

```bash
claude --plugin-dir mods/read-aloud
```
