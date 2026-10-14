import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  HookStream,
  ProcessSpawnChunk,
  ProcessSpawnResult,
  Register,
  RenderComponent,
  RenderSurface,
} from 'claude-code'

import type { Reading } from '../types'
import {
  chunks,
  hasStartedSpeaking,
  killCommand,
  parseAsk,
  pidOf,
  selectionCommands,
  speechCommand,
  toSpeech,
} from './speech'
import type { Platform, SpeechOptions } from './speech'

const reading = atom({ plugin: 'read-aloud', key: 'reading' } as const, null)
const planPath = atom({ plugin: 'read-aloud', key: 'planPath' } as const, null)
const frame = atom({ plugin: 'read-aloud', key: 'frame' } as const, 0)

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPINNER =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24">' +
  '<circle cx="12" cy="12" r="9" fill="none" stroke="#8a8a8a" stroke-opacity="0.3" stroke-width="3"/>' +
  '<path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke="#8a8a8a" stroke-width="3" stroke-linecap="round">' +
  '<animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite"/>' +
  '</path></svg>'

const HELP = [
  'read-aloud reads text aloud. Under each reply: Read message reads it, Read selection reads what you selected.',
  '/read-aloud            the selected text, or else the last reply',
  '/read-aloud plan       the current plan',
  '/read-aloud last       the last reply',
  '/read-aloud selection  the selected text (in the fullscreen terminal)',
  '/read-aloud stop       stops reading',
].join('\n')

// The reading in progress. The module's own: a reload kills its child, and
// session.start clears the state the Stop buttons read.
let current: { stop: () => void } | null = null
let platform: { name: Platform; linuxProgram?: string } | null = null

const platformOf = async ($: EngineInterface): Promise<{ name: Platform; linuxProgram?: string }> => {
  if (platform !== null) return platform
  if ((await $.env.get('OS')) === 'Windows_NT') return (platform = { name: 'windows' })
  const uname = await $.process.run(['uname', '-s']).catch(() => undefined)
  const kernel = uname?.stdout.trim() ?? ''
  if (kernel === 'Darwin') return (platform = { name: 'mac' })
  if (kernel === 'Linux') {
    for (const program of ['espeak-ng', 'espeak']) {
      const found = await $.process.run(['which', program]).catch(() => undefined)
      if (found?.exitCode === 0) return (platform = { name: 'linux', linuxProgram: program })
    }
    return (platform = { name: 'linux' })
  }
  return (platform = { name: 'other' })
}

let speech: SpeechOptions = { voice: '', speed: 100, readCode: false }

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const stop = async ($: EngineInterface): Promise<void> => {
  const was = current
  current = null
  was?.stop()
  await update($, reading, () => null)
}

// Reads aloud the text `source` finds, until it ends or Stop is pressed. From
// the press until the voice starts (finding a selection, starting PowerShell)
// the reading is `isStarting`, which the buttons draw as a spinner. Never
// rejects: a failure is a toast, since a press has nobody else to tell.
const readAloud = async (
  $: EngineInterface,
  who: Omit<Reading, 'isStarting'>,
  source: () => Promise<string | undefined>,
  nothing: string,
): Promise<void> => {
  await stop($)
  const { name, linuxProgram } = await platformOf($)

  let isStopped = false
  let pid: string | undefined
  let child: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | null = null
  // The program writes nothing while it speaks, so Stop kills it by its
  // process id rather than wait on its output; ending the stream is a backup.
  const kill = () => {
    if (pid !== undefined) void $.process.run(killCommand(name, pid)).catch(() => undefined)
  }
  const mine = {
    stop: () => {
      isStopped = true
      kill()
      void child?.return({ code: null, signal: null }).catch(() => undefined)
    },
  }
  current = mine
  await update($, reading, () => ({ ...who, isStarting: true }))

  // The terminal draws the spinner as text, one frame per tick.
  const ticker = $.clock.every(100, () => {
    void update($, frame, n => (n ?? 0) + 1).catch(() => undefined)
  })
  let isSpeaking = false
  const speaking = async () => {
    if (isSpeaking) return
    isSpeaking = true
    ticker.cancel()
    if (current === mine) await update($, reading, now => (now === null ? now : { ...now, isStarting: false }))
  }

  try {
    const text = await source()
    if (isStopped) return
    const spoken = text === undefined ? '' : toSpeech(text, speech.readCode)
    if (spoken === '') {
      $.ui.toast(nothing)
      return
    }

    const command = speechCommand(name, spoken, speech, linuxProgram)
    if (command !== null) {
      const stream = $.process.spawn({ argv: command.argv, input: command.input })
      child = stream
      let stdout = ''
      let stderr = ''
      for await (const piece of stream) {
        if (piece.stream === 'stderr') {
          stderr += piece.text
          continue
        }
        if (isSpeaking) continue
        stdout += piece.text
        if (pid === undefined) {
          pid = pidOf(stdout)
          if (pid !== undefined && isStopped) kill()
        }
        if (hasStartedSpeaking(name, stdout)) await speaking()
      }
      const ended = await stream.result.catch(() => undefined)
      if (!isStopped && ended !== undefined && ended.code !== 0) {
        throw new Error(stderr.trim().split('\n').at(-1) || `the speech program exited with ${ended.code}`)
      }
    } else {
      // The platform's own synthesizer cannot be cut mid-sentence, so speak
      // a few sentences at a time and stop between them.
      await speaking()
      for (const piece of chunks(spoken)) {
        if (isStopped) break
        await $.audio.speak(piece, speech.voice ? { voice: speech.voice } : undefined)
      }
    }
  } catch (error) {
    if (!isStopped) $.ui.toast(`Could not speak: ${errorText(error)}`)
  } finally {
    ticker.cancel()
    if (current === mine) {
      current = null
      await update($, reading, () => null)
    }
  }
}

// Starts a reading and returns at once, so the press or command that asked
// for it is answered while the voice goes on.
const start = (
  $: EngineInterface,
  who: Omit<Reading, 'isStarting'>,
  source: () => Promise<string | undefined>,
  nothing = 'There is nothing to read here.',
): void => {
  void readAloud($, who, source, nothing).catch(() => undefined)
}

// While a reading starts: a spinning ring where the surface draws SVG, a
// turning braille frame on the terminal.
const spinner = async ($: EngineInterface, surface: RenderSurface, component: RenderComponent) => {
  if (surface === 'terminal') {
    const { Text } = $.ui.resolve({ surface, component })
    const n = await read($, frame)
    return <Text color="claude">{FRAMES[n % FRAMES.length]}</Text>
  }
  const { Svg } =
    surface === 'desktop'
      ? $.ui.resolve({ surface, component })
      : surface === 'vscode'
        ? $.ui.resolve({ surface, component })
        : $.ui.resolve({ surface, component })
  return <Svg source={SPINNER} alt="Starting" width={14} height={14} isInteractive />
}

const selectedText = async ($: EngineInterface): Promise<string | undefined> => {
  const selected = await $.ui.selection().catch(() => undefined)
  const text = selected?.text.trim()
  return text === undefined || text === '' ? undefined : text
}

// The text selected on screen, which Claude Code shares only in the
// fullscreen terminal; elsewhere the platform's way to read it, if it has one
// for the surface pressed on (selectionCommands).
const selectionOn = async ($: EngineInterface, surface: string | undefined): Promise<string | undefined> => {
  const shared = await selectedText($)
  if (shared !== undefined) return shared
  const { name } = await platformOf($)
  for (const argv of selectionCommands(name, surface)) {
    const found = await $.process.run(argv, { timeoutMs: 10_000 }).catch(() => undefined)
    if (found?.exitCode === 0 && found.stdout.trim() !== '') return found.stdout.trim()
  }
  return undefined
}

const planText = async ($: EngineInterface): Promise<string | undefined> => {
  const path = await read($, planPath)
  if (path === null) return undefined
  const text = await $.fs.read(path).catch(() => undefined)
  return typeof text === 'string' && text.trim() !== '' ? text : undefined
}

const lastReply = async ($: EngineInterface): Promise<string | undefined> => {
  const messages = await $.session.messages()
  return messages.findLast(one => one.role === 'assistant' && one.text.trim() !== '')?.text
}

export const register: Register = (on, options) => {
  speech = {
    voice: String(options.voice ?? '').trim(),
    speed: Number(options.speed ?? 100),
    readCode: options.readCode === true,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'read-aloud',
      description: 'Read text aloud: the selection or the last reply, the plan, or stop',
      argumentHint: '[plan | last | selection | stop]',
    })
    // A reload ends the reading it had going; clear its Stop buttons.
    await update($, reading, () => null)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await stop($)

    return next(e)
  })

  // Plan mode names the file it writes the plan to in its reminders.
  on('prompt.attachment', async ($, e, next) => {
    if (e.type === 'plan_mode' || e.type === 'plan_mode_reentry' || e.type === 'plan_mode_exit') {
      const path = e.detail?.planFilePath
      if (typeof path === 'string' && path !== '') await update($, planPath, () => path)
    }

    return next(e)
  })

  on('command.run', { command: 'read-aloud' }, async ($, e) => {
    const ask = parseAsk(e.args)

    if (ask === 'help') return { text: HELP }
    if (ask === 'stop') {
      const was = await read($, reading)
      await stop($)
      return { text: was === null ? 'read-aloud: nothing is being read.' : 'read-aloud: stopped.' }
    }
    if (ask === 'plan') {
      const plan = await planText($)
      if (plan === undefined) return { text: 'read-aloud: there is no plan in this session yet.' }
      start($, { id: 'command', what: 'the plan' }, async () => plan)
      return { text: 'read-aloud: reading the plan. /read-aloud stop stops it.' }
    }

    // A command is typed in the prompt box, so a selection in the desktop
    // app is gone by then: only one Claude Code or Linux shares is read here.
    const selection = ask === 'last' ? undefined : await selectionOn($, undefined)
    if (selection !== undefined) {
      start($, { id: 'command', what: 'the selection' }, async () => selection)
      return { text: 'read-aloud: reading the selection. /read-aloud stop stops it.' }
    }
    if (ask === 'selection') {
      return { text: 'read-aloud: nothing is selected that a command can read. Select text in a reply and press Read selection under it.' }
    }

    const reply = await lastReply($)
    if (reply === undefined) return { text: 'read-aloud: there is no reply to read yet.' }
    start($, { id: 'command', what: 'the last reply' }, async () => reply)
    return { text: 'read-aloud: reading the last reply. /read-aloud stop stops it.' }
  })

  // Under each block of a reply: Read message and Read selection; while that
  // block is being read, Stop, with a spinner until the voice starts.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const drawn = await next(e)
    if (e.props.isSummary === true || e.props.text.trim() === '') return drawn

    const now = await read($, reading)
    const { Box, Button, Text } = $.ui.resolve(e)
    const text = e.props.text
    const nothingSelected =
      e.surface === 'terminal'
        ? 'Nothing is selected. In a terminal, select the text with the mouse in the fullscreen layout, then press Read selection.'
        : 'Nothing is selected. Select some text, then press Read selection.'

    return (
      <Box flexDirection="column">
        {drawn}
        {now?.id === e.requestId ? (
          <Box alignItems="center" gap={1}>
            {now.isStarting && (await spinner($, e.surface, e.component))}
            <Button key="stop" label="■ Stop" variant="primary" onPress={() => stop($)} />
            <Text dimColor>{now.isStarting ? `Starting to read ${now.what}…` : `Reading ${now.what}`}</Text>
          </Box>
        ) : (
          <Box gap={1}>
            <Button
              key="read"
              label="🔊 Read message"
              dimColor
              onPress={() => start($, { id: e.requestId, what: 'the message' }, async () => text)}
            />
            <Button
              key="selection"
              label="🔊 Read selection"
              dimColor
              onPress={() =>
                start($, { id: e.requestId, what: 'the selection' }, () => selectionOn($, e.surface), nothingSelected)
              }
            />
          </Box>
        )}
      </Box>
    )
  })

  // The plan Claude presents when it leaves plan mode.
  on('ui.render', { component: 'ToolUse', props: { tool: 'ExitPlanMode' } }, async ($, e, next) => {
    const drawn = await next(e)
    const now = await read($, reading)
    const { Box, Button } = $.ui.resolve(e)
    const output = e.props.output as { plan?: string | null } | undefined
    const plan = typeof output?.plan === 'string' && output.plan.trim() !== '' ? output.plan : undefined
    const readPlan = () =>
      start($, { id: e.requestId, what: 'the plan' }, async () => plan ?? (await planText($)), 'The plan is not available to read.')

    return (
      <Box flexDirection="column">
        {drawn}
        <Box alignItems="center" gap={1}>
          {now?.id === e.requestId && now.isStarting && (await spinner($, e.surface, e.component))}
          {now?.id === e.requestId ? (
            <Button key="stop" label="■ Stop" variant="primary" onPress={() => stop($)} />
          ) : (
            <Button key="read-plan" label="🔊 Read plan" dimColor onPress={readPlan} />
          )}
        </Box>
      </Box>
    )
  })

  // While anything is being read, a Stop button above the prompt, wherever
  // the transcript is scrolled.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, reading)
    if (now === null || e.props.hasSurvey) return next(e)

    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {below}
        <Box alignItems="center" gap={1}>
          {now.isStarting ? await spinner($, e.surface, e.component) : <Text>🔊</Text>}
          <Text>{now.isStarting ? `Starting to read ${now.what}…` : `Reading ${now.what} aloud`}</Text>
          <Button key="stop" label="■ Stop" variant="primary" onPress={() => stop($)} />
        </Box>
      </Box>
    )
  })
}
