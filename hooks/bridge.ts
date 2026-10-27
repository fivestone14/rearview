// The files Rearview shares with its Obsidian view (obsidian/ in this repository):
//
//   turns.json   -> the recorded turns and their reviews, rewritten whenever they change
//   session.json -> a random code for this session, made when it starts
//   inbox.jsonl  -> steers typed in Obsidian, one JSON line each, read and emptied every few seconds
//
// A steer is sent to Claude only when it carries this session's code, so an inbox file that came
// with a cloned project, or was left from an earlier session, can never put words in Claude's mouth.

import type { EngineInterface } from 'claude-code'

import { readProjectFile, writeProjectFile } from './paths'
import { recordSignal } from './principles'
import { setProposedRule } from './state'
import type { Turn } from '../types'

const TURNS_FILE = '.claude/rearview/turns.json'
const SESSION_FILE = '.claude/rearview/session.json'
const INBOX_FILE = '.claude/rearview/inbox.jsonl'
/** How often the inbox is read. */
const INBOX_POLL_MS = 2000
/** A steer longer than this is cut, as a typed correction never needs more. */
const MAX_STEER_CHARS = 4000

/** One line of inbox.jsonl, as the Obsidian view writes it. */
type InboxEntry = { code?: unknown; text?: unknown; remember?: unknown }

/** Writes the turns for the Obsidian view, without Claude's full messages, which only the reviewer needs. */
export async function exportTurns($: EngineInterface, turns: Turn[]): Promise<void> {
  const shared = turns.map(({ agentMessages: _, ...turn }) => turn)
  const file = { version: 1, root: await $.session.root(), updatedAt: Date.now(), turns: shared }
  await writeProjectFile($, TURNS_FILE, JSON.stringify(file))
}

/** This module's session code; a reload of the plugin starts over with none. */
let sessionCode: string | null = null

/**
 * Makes this session's code, empties any old inbox, and starts reading steers. Called at session start
 * and again at each turn start, since /reload-plugins loads new code without a new session start.
 */
export async function startBridge($: EngineInterface): Promise<void> {
  if (sessionCode !== null) return
  const code = crypto.randomUUID()
  sessionCode = code
  await writeProjectFile($, INBOX_FILE, '')
  await writeProjectFile($, SESSION_FILE, JSON.stringify({ code, startedAt: Date.now() }))
  $.clock.every(INBOX_POLL_MS, () => {
    readInbox($, code).catch(error => $.ui.log(`Rearview inbox: ${String(error)}`))
  })
}

async function readInbox($: EngineInterface, code: string): Promise<void> {
  const text = await readProjectFile($, INBOX_FILE)
  if (text === null || text.trim() === '') return
  await writeProjectFile($, INBOX_FILE, '')
  for (const entry of parseInbox(text, code)) {
    await $.prompt.submit({ text: `A correction from the Rearview review in Obsidian: ${entry.text}` })
    await recordSignal($, { at: Date.now(), kind: 'steer', step: 'Obsidian', text: entry.text })
    // Remembering goes through the pane's usual approval, so nothing becomes a principle unseen.
    if (entry.remember) await setProposedRule($, { rule: entry.text, steers: 1 })
  }
}

/** The inbox lines that carry `code` and some text. Anything else is dropped. */
export function parseInbox(text: string, code: string): { text: string; remember: boolean }[] {
  return text
    .split('\n')
    .map(line => {
      try {
        return JSON.parse(line) as InboxEntry
      } catch {
        return null
      }
    })
    .filter((entry): entry is InboxEntry => entry !== null && typeof entry === 'object' && entry.code === code)
    .map(entry => ({ text: typeof entry.text === 'string' ? entry.text.trim().slice(0, MAX_STEER_CHARS) : '', remember: entry.remember === true }))
    .filter(entry => entry.text !== '')
}
