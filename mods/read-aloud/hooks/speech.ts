// What read-aloud says and which program says it: pure functions, so the
// tests can check them without a speaker.

export type Platform = 'windows' | 'mac' | 'linux' | 'other'

export type SpeechOptions = { voice: string; speed: number; readCode: boolean }

/**
 * A command that speaks the text it is given on standard input. It first
 * writes its process id on a line of its own, so Stop can kill it; on
 * Windows, a line `speaking` as the voice starts.
 */
export type SpeechCommand = { argv: string[]; input: string }

/**
 * The longest text one reading speaks. A plan of 20,000 characters takes about
 * 20 minutes to hear; longer than that, select the part you want.
 */
export const MAX_CHARS = 20_000

/**
 * Turns markdown, as Claude writes it, into text a speech synthesizer reads
 * well: no symbols, a pause after each heading, list item and table row, and
 * code blocks skipped unless `readCode`.
 */
export function toSpeech(markdown: string, readCode = false): string {
  const lines: string[] = []
  let inCode = false

  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const fence = /^\s*(```|~~~)/.test(raw)
    if (fence) {
      if (!inCode && !readCode) lines.push('Code block skipped.')
      inCode = !inCode
      continue
    }
    if (inCode) {
      if (readCode) lines.push(sentence(raw.trim()))
      continue
    }
    // Table separators and horizontal rules say nothing.
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(raw)) continue
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) continue

    let line = raw
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*>+\s?/, '')
      .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*(\d+)[.)]\s+/, '$1. ')
    if (/^\s*\|.*\|\s*$/.test(line)) {
      line = line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map(cell => cell.trim())
        .filter(cell => cell !== '')
        .join(', ')
    }
    lines.push(sentence(inline(line).trim()))
  }

  return lines
    .filter(line => line !== '')
    .join('\n')
    .slice(0, MAX_CHARS)
}

function inline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<(https?:\/\/[^>]+)>/g, 'a link')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\s+/g, ' ')
}

/** Ends a line with a full stop when it has no punctuation, so the voice pauses. */
function sentence(line: string): string {
  if (line === '') return ''
  return /[.!?:;,]$/.test(line) ? line : `${line}.`
}

/** The platform's speech program for the text, or null to use `$.audio.speak`. */
export function speechCommand(
  platform: Platform,
  text: string,
  options: SpeechOptions,
  linuxProgram?: string,
): SpeechCommand | null {
  const { voice, speed } = options

  if (platform === 'windows') {
    // Windows PowerShell 5.1 ships System.Speech; PowerShell 7 does not.
    const script = [
      "$ErrorActionPreference = 'Stop'",
      '[Console]::Out.WriteLine($PID); [Console]::Out.Flush()',
      '[Console]::InputEncoding = [Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      `$s.Rate = ${windowsRate(speed)}`,
      ...(voice ? [`$s.SelectVoice('${voice.replace(/'/g, "''")}')`] : []),
      '$t = [Console]::In.ReadToEnd()',
      "[Console]::Out.WriteLine('speaking'); [Console]::Out.Flush()",
      '$s.Speak($t)',
    ].join('; ')
    return {
      argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
      input: text,
    }
  }
  if (platform === 'mac') {
    return {
      argv: withPid(['say', ...(voice ? ['-v', voice] : []), '-r', String(wordsPerMinute(speed)), '-f', '-']),
      input: text,
    }
  }
  if (platform === 'linux' && linuxProgram) {
    return {
      argv: withPid([linuxProgram, ...(voice ? ['-v', voice] : []), '-s', String(wordsPerMinute(speed)), '--stdin']),
      input: text,
    }
  }
  return null
}

/** Runs `argv` through sh, which writes its process id and then becomes the program. */
function withPid(argv: string[]): string[] {
  return ['/bin/sh', '-c', 'echo $$; exec "$@"', 'sh', ...argv]
}

/** The process id a speech command wrote on its first line, once that line is whole. */
export function pidOf(output: string): string | undefined {
  return /^\s*(\d+)\r?\n/.exec(output)?.[1]
}

// Copies the selection in the window the person just pressed a button in, by
// pressing Ctrl+C there, prints it and puts the clipboard back as it was. The
// clipboard's sequence number tells a copy from none, so with nothing selected
// it prints nothing rather than what was copied before.
const WINDOWS_COPY_SELECTION = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Windows.Forms',
  `Add-Type -Namespace ReadAloud -Name Clip -MemberDefinition '[DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();'`,
  '$saved = New-Object System.Windows.Forms.DataObject',
  '$hadAny = $false',
  '$old = [System.Windows.Forms.Clipboard]::GetDataObject()',
  'if ($old -ne $null) {',
  '  foreach ($format in $old.GetFormats($false)) {',
  '    try { $data = $old.GetData($format); if ($data -ne $null) { $saved.SetData($format, $data); $hadAny = $true } } catch {}',
  '  }',
  '}',
  '$before = [ReadAloud.Clip]::GetClipboardSequenceNumber()',
  "[System.Windows.Forms.SendKeys]::SendWait('^c')",
  '$deadline = [DateTime]::Now.AddMilliseconds(1500)',
  'while ([ReadAloud.Clip]::GetClipboardSequenceNumber() -eq $before -and [DateTime]::Now -lt $deadline) { Start-Sleep -Milliseconds 30 }',
  'if ([ReadAloud.Clip]::GetClipboardSequenceNumber() -eq $before) { exit 0 }',
  'Start-Sleep -Milliseconds 30',
  '$text = [System.Windows.Forms.Clipboard]::GetText()',
  'try { if ($hadAny) { [System.Windows.Forms.Clipboard]::SetDataObject($saved, $true) } else { [System.Windows.Forms.Clipboard]::Clear() } } catch {}',
  '[Console]::Out.Write($text)',
].join('\n')

// The same on macOS: Cmd+C through System Events (which needs Accessibility
// access for Claude), the pasteboard's change count, and its text put back.
const MAC_COPY_SELECTION = [
  "ObjC.import('AppKit')",
  'const pb = $.NSPasteboard.generalPasteboard',
  'const before = pb.changeCount',
  'const old = pb.stringForType($.NSPasteboardTypeString)',
  "Application('System Events').keystroke('c', { using: 'command down' })",
  'for (let i = 0; i < 50 && pb.changeCount === before; i++) delay(0.03)',
  "let text = ''",
  'if (pb.changeCount !== before) {',
  '  delay(0.03)',
  "  text = ObjC.unwrap(pb.stringForType($.NSPasteboardTypeString)) || ''",
  '  if (!old.isNil()) { pb.clearContents; pb.setStringForType(old, $.NSPasteboardTypeString) }',
  '}',
  'text',
].join('\n')

/**
 * Commands that print the text selected on screen, tried in order; none where
 * there is no safe way to read it.
 *
 * Claude Code shares a selection with mods only in the fullscreen terminal. A
 * press in the desktop app copies the selection there itself (Ctrl+C, then the
 * clipboard put back); a press in a terminal never does, since Ctrl+C there
 * interrupts Claude. Linux reads the primary selection, which needs no copy.
 */
export function selectionCommands(platform: Platform, surface: string | undefined): string[][] {
  if (platform === 'linux') {
    return [['wl-paste', '--primary', '--no-newline'], ['xclip', '-selection', 'primary', '-o'], ['xsel', '--primary', '--output']]
  }
  if (surface !== 'desktop') return []
  if (platform === 'windows') {
    return [['powershell.exe', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encodePowerShell(WINDOWS_COPY_SELECTION)]]
  }
  if (platform === 'mac') return [['osascript', '-l', 'JavaScript', '-e', MAC_COPY_SELECTION]]
  return []
}

/** A script as `powershell -EncodedCommand` takes it: UTF-16LE, then base64. */
export function encodePowerShell(script: string): string {
  const bytes: number[] = []
  for (let i = 0; i < script.length; i++) {
    const code = script.charCodeAt(i)
    bytes.push(code & 0xff, code >> 8)
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]]
    const n = (a << 16) | (b << 8) | c
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? alphabet[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? alphabet[n & 63]! : '='
  }
  return out
}

/**
 * Whether the speech program has started to speak, from what it wrote so far:
 * Windows says `speaking` once PowerShell has loaded its voice; `say` and
 * espeak start at once, so their process id is the sign.
 */
export function hasStartedSpeaking(platform: Platform, output: string): boolean {
  return platform === 'windows' ? /^speaking\r?$/m.test(output) : pidOf(output) !== undefined
}

/** The command that kills a speech program, so Stop is immediate. */
export function killCommand(platform: Platform, pid: string): string[] {
  return platform === 'windows' ? ['taskkill', '/PID', pid, '/T', '/F'] : ['kill', pid]
}

/** Speed in percent (100 is normal) as Windows' rate, -10 to 10, where 10 is about 3 times. */
export function windowsRate(speed: number): number {
  const rate = Math.round((10 * Math.log(clampSpeed(speed) / 100)) / Math.log(3))
  return Math.max(-10, Math.min(10, rate))
}

/** Speed in percent as words per minute, 175 being normal for `say` and espeak. */
export function wordsPerMinute(speed: number): number {
  return Math.round((175 * clampSpeed(speed)) / 100)
}

function clampSpeed(speed: number): number {
  return Number.isFinite(speed) && speed > 0 ? Math.max(30, Math.min(300, speed)) : 100
}

/**
 * Splits text into pieces of about `size` characters at sentence ends, for the
 * fallback synthesizer, which can only stop between pieces.
 */
export function chunks(text: string, size = 300): string[] {
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*|\n+/g) ?? [text]
  const out: string[] = []
  let piece = ''
  for (const one of sentences) {
    if (piece !== '' && piece.length + one.length > size) {
      out.push(piece.trim())
      piece = ''
    }
    piece += one
  }
  if (piece.trim() !== '') out.push(piece.trim())
  return out.filter(one => one !== '')
}

/** What `/read-aloud <args>` asks for. */
export type Ask = 'auto' | 'stop' | 'plan' | 'last' | 'selection' | 'help'

export function parseAsk(args: string): Ask {
  const word = args.trim().toLowerCase()
  if (word === '') return 'auto'
  if (word === 'stop' || word === 'off') return 'stop'
  if (word === 'plan') return 'plan'
  if (word === 'last' || word === 'reply') return 'last'
  if (word === 'selection' || word === 'selected') return 'selection'
  return 'help'
}
