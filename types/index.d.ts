export type TocEntry = {
  /** The turn the entry belongs to (turn.start's turnId). */
  turnId: string
  /** 1-based number shown before the title. */
  n: number
  /** What the person typed, trimmed to a few hundred characters. */
  question: string
  /** The short topic shown in the pane; a cut of the question until Haiku answers. */
  title: string
  /** Transcript id of the answer's last text block; null until one is appended. */
  answerId: string | null
  /** True while the title is still the raw cut, not yet formulated. */
  isPending: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'chat-toc': {
      entries: Shaped<TocEntry[]>
      activeTurn: Shaped<string | null>
      pendingQuestion: Shaped<string | null>
    }
  }
}
