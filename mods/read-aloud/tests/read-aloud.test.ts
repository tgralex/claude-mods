import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, ProcessSpawnRequest } from 'claude-code'

import {
  chunks,
  encodePowerShell,
  hasStartedSpeaking,
  killCommand,
  parseAsk,
  pidOf,
  selectionCommands,
  speechCommand,
  toSpeech,
  windowsRate,
  wordsPerMinute,
} from '../hooks/speech'

const SURFACES = ['terminal', 'desktop'] as const
const OPTIONS = { voice: '', speed: 100, readCode: false }

const PLAN = [
  '# Plan: add a read-aloud mod',
  '',
  '1. Write **hooks/register.tsx** with a `ui.render` hook.',
  '2. Add [tests](https://example.com/tests).',
  '',
  '```ts',
  'const x = 1',
  '```',
  '',
  '| Step | Owner |',
  '| --- | --- |',
  '| Build | Claude |',
].join('\n')

describe('toSpeech', () => {
  test('reads markdown as plain sentences and skips code', () => {
    expect(toSpeech(PLAN)).toBe(
      [
        'Plan: add a read-aloud mod.',
        '1. Write hooks/register.tsx with a ui.render hook.',
        '2. Add tests.',
        'Code block skipped.',
        'Step, Owner.',
        'Build, Claude.',
      ].join('\n'),
    )
  })

  test('reads code when asked to', () => {
    expect(toSpeech('```\nconst x = 1\n```', true)).toBe('const x = 1.')
  })

  test('keeps underscores inside names and drops bare links', () => {
    expect(toSpeech('Set max_tokens, see https://example.com/docs')).toBe('Set max_tokens, see a link.')
  })

  test('has nothing to say for an empty reply', () => {
    expect(toSpeech('\n\n---\n')).toBe('')
  })
})

describe('speechCommand', () => {
  test('Windows speaks through PowerShell, text on standard input', () => {
    const command = speechCommand('windows', 'Hello.', { ...OPTIONS, voice: "Zira's" })

    expect(command?.argv[0]).toBe('powershell.exe')
    expect(command?.argv.at(-1)).toContain("SelectVoice('Zira''s')")
    expect(command?.argv.at(-1)).toContain('$s.Rate = 0')
    expect(command?.argv.at(-1)).toMatch(/WriteLine\('speaking'\).*\$s\.Speak\(\$t\)/)
    expect(command?.input).toBe('Hello.')
  })

  test('macOS speaks through say, Linux through espeak, others through the engine', () => {
    const sh = ['/bin/sh', '-c', 'echo $$; exec "$@"', 'sh']
    expect(speechCommand('mac', 'Hi.', { ...OPTIONS, speed: 200 })?.argv).toEqual([...sh, 'say', '-r', '350', '-f', '-'])
    expect(speechCommand('linux', 'Hi.', OPTIONS, 'espeak-ng')?.argv).toEqual([...sh, 'espeak-ng', '-s', '175', '--stdin'])
    expect(speechCommand('linux', 'Hi.', OPTIONS)).toBeNull()
    expect(speechCommand('other', 'Hi.', OPTIONS)).toBeNull()
  })

  test('speed maps onto each synthesizer and stays in range', () => {
    expect(windowsRate(100)).toBe(0)
    expect(windowsRate(300)).toBe(10)
    expect(windowsRate(1000)).toBe(10)
    expect(windowsRate(50)).toBe(-6)
    expect(wordsPerMinute(Number.NaN)).toBe(175)
  })

  test('Stop kills the program by the process id it wrote first', () => {
    expect(speechCommand('windows', 'Hi.', OPTIONS)?.argv.at(-1)).toContain('[Console]::Out.WriteLine($PID)')
    expect(pidOf('42')).toBeUndefined()
    expect(pidOf('4242\r\n')).toBe('4242')
    expect(killCommand('windows', '4242')).toEqual(['taskkill', '/PID', '4242', '/T', '/F'])
    expect(killCommand('mac', '4242')).toEqual(['kill', '4242'])
  })

  test('the selection is copied only on a desktop press; Linux reads its primary selection', () => {
    expect(selectionCommands('windows', 'terminal')).toEqual([])
    expect(selectionCommands('windows', undefined)).toEqual([])
    expect(selectionCommands('mac', 'terminal')).toEqual([])
    expect(selectionCommands('windows', 'desktop')[0]?.[0]).toBe('powershell.exe')
    expect(selectionCommands('mac', 'desktop')[0]?.[0]).toBe('osascript')
    expect(selectionCommands('linux', 'terminal')[0]).toEqual(['wl-paste', '--primary', '--no-newline'])
  })

  test('PowerShell scripts are encoded as UTF-16LE base64', () => {
    expect(encodePowerShell('ab')).toBe('YQBiAA==')
    expect(encodePowerShell('é')).toBe('6QA=')
  })

  test('Windows says when its voice starts; say and espeak start at once', () => {
    expect(hasStartedSpeaking('windows', '4242\r\n')).toBe(false)
    expect(hasStartedSpeaking('windows', '4242\r\nspeaking\r\n')).toBe(true)
    expect(hasStartedSpeaking('mac', '4242\n')).toBe(true)
  })

  test('the fallback is cut at sentence ends', () => {
    expect(chunks('One. Two. Three.', 10)).toEqual(['One. Two.', 'Three.'])
  })

  test('the command reads its argument', () => {
    expect(parseAsk('')).toBe('auto')
    expect(parseAsk(' Stop ')).toBe('stop')
    expect(parseAsk('plan')).toBe('plan')
    expect(parseAsk('banana')).toBe('help')
  })
})

// A speech program that writes its process id, then, as Windows' does once
// its voice is loaded, `speaking` (at once, or when the test calls `speak`
// with `holdVoice`), then says nothing until the test lets it end or it is
// killed. It records what it was asked and the kills. Any other command reads
// the selection on screen: what `onScreen` returns.
const fakeSpeaker = (on: On, onScreen: () => string = () => '', holdVoice = false) => {
  const spawned: ProcessSpawnRequest[] = []
  const kills: (readonly string[])[] = []
  const ran: (readonly string[])[] = []
  let finish = () => {}
  let speak = () => {}
  let started = () => {}
  let heard = () => {}
  const isStarted = new Promise<void>(resolve => (started = resolve))
  const isHeard = new Promise<void>(resolve => (heard = resolve))
  on('process.spawn', async function* ($, e) {
    spawned.push(e)
    const ended = new Promise<void>(resolve => (finish = resolve))
    const voiced = new Promise<void>(resolve => (speak = resolve))
    yield { stream: 'stdout' as const, text: '4242\r\n' }
    started()
    if (holdVoice) await Promise.race([voiced, ended])
    yield { stream: 'stdout' as const, text: 'speaking\r\n' }
    // Runs once the mod has handled the line and asks for more.
    heard()
    await ended
    return { value: { code: 0, signal: null } }
  })
  on('process.run', ($, e) => {
    const isKill = e.argv[0] === 'taskkill' || e.argv[0] === 'kill'
    if (isKill) {
      kills.push(e.argv)
      finish()
    }
    if (!isKill) ran.push(e.argv)
    const stdout = isKill ? '' : onScreen()
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { spawned, kills, ran, isStarted, isHeard, speak: () => speak(), finish: () => finish() }
}

// The toasts the mod raised.
const toasts = (on: On) => {
  const said: string[] = []
  on('ui.toast', (_$, e) => {
    said.push(e.text)
    return { value: undefined }
  })
  return said
}

// The engine's own drawing of a reply or a tool row, which the mod wraps.
const engineDraws = (on: On) =>
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: 'drawn by the engine' })
  })

describe('buttons', () => {
  test('a reply gets Read message, which speaks it and shows Stop until it ends', async ($, on) => {
    mock.env(on, { OS: 'Windows_NT' })
    mock.clock(on)
    const speaker = fakeSpeaker(on)
    engineDraws(on)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({
        plugin: 'read-aloud',
        surface,
        component: 'AssistantMessage',
        requestId: `msg-${surface}`,
        props: { text: '## Plan\n- Step **one**', isFirstOfReply: true },
      })
      expect(await ui.find({ type: 'Text', text: 'drawn by the engine' })).toBeDefined()
      expect((await ui.find({ key: 'read' }))?.props.label).toBe('🔊 Read message')
      expect((await ui.find({ key: 'selection' }))?.props.label).toBe('🔊 Read selection')

      const pressed = ui.press({ key: 'read' })
      await speaker.isStarted
      expect(speaker.spawned.at(-1)?.input).toBe('Plan.\nStep one.')
      expect(await ui.find({ key: 'stop' })).toBeDefined()

      speaker.finish()
      await pressed
      expect(await ui.find({ key: 'read' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('Stop above the prompt ends the reading', async ($, on) => {
    mock.env(on, { OS: 'Windows_NT' })
    mock.clock(on)
    const speaker = fakeSpeaker(on)
    engineDraws(on)
    const band = await $.ui.mount({
      plugin: 'read-aloud',
      surface: 'desktop',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    expect(await band.find({ key: 'stop' })).toBeUndefined()

    const reply = await $.ui.mount({
      plugin: 'read-aloud',
      surface: 'desktop',
      component: 'AssistantMessage',
      requestId: 'msg-stop',
      props: { text: 'A long plan.', isFirstOfReply: true },
    })
    const pressed = reply.press({ key: 'read' })
    await speaker.isStarted
    await speaker.isHeard
    expect(await band.find({ type: 'Text', text: 'Reading the message aloud' })).toBeDefined()

    await band.press({ key: 'stop' })
    expect(speaker.kills).toEqual([['taskkill', '/PID', '4242', '/T', '/F']])
    await pressed
    expect(await band.find({ key: 'stop' })).toBeUndefined()
  })

  for (const surface of SURFACES) {
    test(`a spinner shows from the press until the voice starts (${surface})`, async ($, on) => {
      mock.env(on, { OS: 'Windows_NT' })
      mock.clock(on)
      const speaker = fakeSpeaker(on, () => '', true)
      engineDraws(on)
      const ui = await $.ui.mount({
        plugin: 'read-aloud',
        surface,
        component: 'AssistantMessage',
        requestId: `msg-spin-${surface}`,
        props: { text: 'Hello.', isFirstOfReply: true },
      })
      const pressed = ui.press({ key: 'read' })
      await speaker.isStarted

      expect(await ui.find({ type: 'Text', text: 'Starting to read the message…' })).toBeDefined()
      if (surface === 'terminal') {
        expect(await ui.find({ type: 'Text', text: /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/ })).toBeDefined()
      } else {
        expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe('Starting')
      }
      expect(await ui.find({ key: 'stop' })).toBeDefined()

      speaker.speak()
      await speaker.isHeard
      expect(await ui.find({ type: 'Text', text: 'Reading the message' })).toBeDefined()
      expect(await ui.find({ type: 'Svg' })).toBeUndefined()

      speaker.finish()
      await pressed
    })
  }

  test('in the fullscreen terminal, Read selection reads what Claude Code shares, never copying', async ($, on) => {
    mock.env(on, { OS: 'Windows_NT' })
    mock.clock(on)
    const speaker = fakeSpeaker(on)
    engineDraws(on)
    let selected: { text: string; requestId?: string } | undefined
    on('ui.selection', () => ({ value: selected }))
    const said = toasts(on)

    const ui = await $.ui.mount({
      plugin: 'read-aloud',
      surface: 'terminal',
      component: 'AssistantMessage',
      requestId: 'msg-sel',
      props: { text: 'First part. Second part.', isFirstOfReply: true },
    })
    await ui.press({ key: 'selection' })
    expect(speaker.spawned).toHaveLength(0)
    // Ctrl+C in a terminal interrupts Claude, so nothing was run to copy.
    expect(speaker.ran).toHaveLength(0)
    expect(said).toEqual([
      'Nothing is selected. In a terminal, select the text with the mouse in the fullscreen layout, then press Read selection.',
    ])

    selected = { text: 'Second part.', requestId: 'msg-sel' }
    const pressed = ui.press({ key: 'selection' })
    await speaker.isStarted
    expect(speaker.spawned[0]?.input).toBe('Second part.')
    speaker.finish()
    await pressed
  })

  test('in the desktop app, Read selection copies the selection itself and reads it', async ($, on) => {
    mock.env(on, { OS: 'Windows_NT' })
    mock.clock(on)
    let onScreen = ''
    const speaker = fakeSpeaker(on, () => onScreen)
    engineDraws(on)
    on('ui.selection', () => ({ value: undefined }))
    const said = toasts(on)
    const ui = await $.ui.mount({
      plugin: 'read-aloud',
      surface: 'desktop',
      component: 'AssistantMessage',
      requestId: 'msg-desktop',
      props: { text: 'The whole reply.', isFirstOfReply: true },
    })

    // Nothing selected: the copy finds nothing, and nothing old is read.
    await ui.press({ key: 'selection' })
    expect(speaker.spawned).toHaveLength(0)
    expect(speaker.ran[0]?.slice(0, 5)).toEqual(['powershell.exe', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand'])
    expect(said).toEqual(['Nothing is selected. Select some text, then press Read selection.'])

    onScreen = 'Selected words.'
    const pressed = ui.press({ key: 'selection' })
    await speaker.isStarted
    expect(speaker.spawned[0]?.input).toBe('Selected words.')
    await speaker.isHeard
    expect(await ui.find({ type: 'Text', text: 'Reading the selection' })).toBeDefined()
    speaker.finish()
    await pressed
  })

  test('the selection command never copies, since the prompt box has the focus', async ($, on) => {
    mock.env(on, { OS: 'Windows_NT' })
    mock.clock(on)
    const speaker = fakeSpeaker(on, () => 'stale clipboard')
    on('ui.selection', () => ({ value: undefined }))
    const { text } = await $.command.run({
      command: 'read-aloud',
      args: 'selection',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })
    expect(text).toContain('nothing is selected')
    expect(speaker.ran).toHaveLength(0)
  })

  test('the plan row gets Read plan aloud, reading the plan it presented', async ($, on) => {
    mock.env(on, { OS: 'Windows_NT' })
    mock.clock(on)
    const speaker = fakeSpeaker(on)
    engineDraws(on)
    const ui = await $.ui.mount({
      plugin: 'read-aloud',
      surface: 'desktop',
      component: 'ToolUse',
      requestId: 'toolu_plan',
      props: {
        tool_use_id: 'toolu_plan',
        tool: 'ExitPlanMode',
        input: {},
        isRunning: false,
        isErrored: false,
        isInterrupted: false,
        output: { plan: '# The plan\nDo it.', isAgent: false },
      },
    })
    const pressed = ui.press({ key: 'read-plan' })
    await speaker.isStarted
    expect(speaker.spawned[0]?.input).toBe('The plan.\nDo it.')
    speaker.finish()
    await pressed
  })
})
