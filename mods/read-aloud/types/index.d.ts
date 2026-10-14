/**
 * What is being read aloud now: the transcript row whose Stop button shows
 * (`id`, a message's or a tool row's requestId, or `command` for one started
 * by `/read-aloud`), what it is, for the band above the prompt, and whether
 * the voice has yet to start (finding the selection, starting PowerShell).
 */
export type Reading = { id: string; what: string; isStarting: boolean }

declare module 'claude-code' {
  interface PluginState {
    'read-aloud': {
      reading: Reading | null
      /** The file plan mode writes its plan to, once the engine has named it. */
      planPath: string | null
      /** The terminal spinner's frame, moved on while a reading starts. */
      frame: number
    }
  }
}
