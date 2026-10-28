import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { TocEntry } from '../types'

const PANE = 'chat-toc'
const TITLE = 'Оглавление'
const MAX_ENTRIES = 500

// Bump the shape tags when an entry's fields change: a reload then declines
// what an earlier version stored.
const entries = atom({ plugin: 'chat-toc', key: 'entries' } as const, [], {
  shape: 'entries-1',
})
const activeTurn = atom({ plugin: 'chat-toc', key: 'activeTurn' } as const, null, {
  shape: 'turn-1',
})
// The person's own prompt, caught at prompt.submit and consumed by the turn it
// starts; a notification, a peer's message or a plugin's prompt leaves it null.
const pendingQuestion = atom({ plugin: 'chat-toc', key: 'pendingQuestion' } as const, null, {
  shape: 'question-1',
})

const SYSTEM =
  'Ты составляешь оглавление чата. По вопросу пользователя и началу ответа ' +
  'сформулируй тему одной короткой фразой: 3–7 слов, на языке вопроса, ' +
  'без кавычек, без точки в конце, без вводных слов и без префикса «Тема:». Отвечай только фразой.'

/** One line, whitespace collapsed, cut to `max` characters. */
const cut = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  if (line.length <= max) return line
  return `${line.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

/** The model's reply as a title: first line, quotes and a trailing dot gone. */
const clean = (reply: string): string => {
  const line = reply.split('\n').map(s => s.trim()).find(s => s.length > 0) ?? ''
  return line
    .replace(/^(тема|topic|заголовок|title)\s*[:：—-]\s*/i, '')
    .replace(/^["«„'`]+|["»“'`.]+$/g, '')
    .trim()
}

const isMain = (e: { agentId?: string }): boolean => e.agentId === undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'toc',
      description: 'Открыть панель «Оглавление» чата',
    })
    // The pane opens by itself only under a terminal, where a click can scroll
    // the transcript. The desktop app (surface null at start: the app attaches
    // later) has its own «Session chapters»; there /toc still opens the pane.
    if (e.surface === 'terminal') {
      void $.ui.open({ id: PANE, title: TITLE, columns: 40 })
    } else if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
      void $.ui.close({ id: PANE })
    }

    return next(e)
  })

  on('command.run', { command: 'toc' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, columns: 40 })

    return { text: 'Панель «Оглавление» открыта.' }
  })

  // Only what the person typed themselves counts as a question: not a task
  // notification, another session's message, a slash command or a plugin's.
  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin.kind
    const isPerson = kind === 'composer' || kind === 'bridge' || kind === 'sdk'
    if (isPerson && e.command === undefined && e.isMeta === undefined && e.turnId === undefined) {
      await update($, pendingQuestion, () => e.text.trim())
    }
    return next(e)
  })

  // A new turn opens a new entry when a question of the person's is waiting.
  on('turn.start', async ($, e, next) => {
    if (!isMain(e)) return next(e)
    const question = (await read($, pendingQuestion)) ?? ''
    await update($, pendingQuestion, () => null)
    if (question.length === 0) {
      await update($, activeTurn, () => null)
      return next(e)
    }
    await update($, entries, list => {
      const entry: TocEntry = {
        turnId: e.turnId,
        n: (list.at(-1)?.n ?? 0) + 1,
        question: question.slice(0, 1500),
        title: cut(question, 60),
        answerId: null,
        isPending: true,
      }
      return [...list, entry].slice(-MAX_ENTRIES)
    })
    await update($, activeTurn, () => e.turnId)
    void $.ui.scroll({ in: PANE, to: 'end' })

    return next(e)
  })

  // Each text block of the model's reply: the entry points at the latest one,
  // so a click lands on the final answer of the turn.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    if (!isMain(e) || e.message.type !== 'assistant') return next(e)
    const hasText = e.message.content.some(
      block => block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0,
    )
    if (!hasText) return next(e)
    const turnId = await read($, activeTurn)
    if (turnId === null) return next(e)
    await update($, entries, list =>
      list.map(one => (one.turnId === turnId ? { ...one, answerId: e.uuid } : one)),
    )

    return next(e)
  })

  // When the turn is done, ask a small model for the topic. The work runs on
  // a timer so the turn's own dispatch is not held up by the request.
  on('turn.complete', async ($, e, next) => {
    if (!isMain(e)) return next(e)
    const turnId = e.turnId
    const answer = e.answer
    $.clock.after(10, () => {
      void (async () => {
        const list = await read($, entries)
        const entry = list.find(one => one.turnId === turnId)
        if (entry === undefined || !entry.isPending) return
        const reply = await $.model.complete({
          model: 'haiku',
          system: SYSTEM,
          prompt: `Вопрос:\n${entry.question}\n\nНачало ответа:\n${answer.slice(0, 1200)}`,
          maxTokens: 80,
          effort: 'low',
          timeoutMs: 20000,
        })
        const title = reply.isAnswered ? cut(clean(reply.text), 80) : ''
        await update($, entries, items =>
          items.map(one =>
            one.turnId === turnId
              ? { ...one, title: title.length > 0 ? title : one.title, isPending: false }
              : one,
          ),
        )
      })()
    })

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, entries)
    const width = Math.max(12, e.props.bodyColumns - 6)

    const jump = (entry: TocEntry) => async () => {
      if (entry.answerId === null) {
        $.ui.toast('Ответ на этот вопрос ещё не записан.')
        return
      }
      const moved = await $.ui.scroll({ to: { requestId: entry.answerId }, block: 'start' })
      if (moved.deny !== undefined) $.ui.log(`chat-toc: переход к ${entry.answerId} отклонён: ${moved.deny}`)
    }

    // The desktop app does not let a plugin scroll the transcript: there the
    // list is read-only, and the app's own «Session chapters» (the ≡ icon at
    // the top left of the transcript) is the clickable index.
    const canJump = e.surface !== 'desktop'

    return (
      <Box flexDirection="column">
        {list.length === 0 && (
          <Text dimColor>Пока пусто: пункты появятся после первого ответа.</Text>
        )}
        {list.map(entry =>
          canJump ? (
            <Button
              key={`entry:${entry.turnId}`}
              plain
              dimColor={entry.answerId === null}
              onPress={jump(entry)}
            >
              {`${entry.n}. ${cut(entry.title, width)}`}
            </Button>
          ) : (
            <Text dimColor={entry.answerId === null}>{`${entry.n}. ${cut(entry.title, width)}`}</Text>
          ),
        )}
        {!canJump && list.length > 0 && (
          <Box marginTop={1}>
            <Text dimColor>Переход по клику: иконка ≡ слева вверху чата (Session chapters).</Text>
          </Box>
        )}
      </Box>
    )
  })
}
