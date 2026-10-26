// Principles: lasting rules learned from the person's steers, stored as a Markdown file in the project.
//
// They are used three ways:
//   1. guide  - added to Claude's system prompt every request (principlesPromptSection)
//   2. warn   - the turn review also checks the changes against them
//   3. block  - edits to the principle's `files` glob are refused (blockingPrinciple)
// Any active principle can also raise a drift question when a new prompt goes against it (findDrift).
//
// Safety: principles reach Claude's system prompt, so a principles file is used only when its exact
// contents were written or approved on this machine (see loadPrinciples). One that comes with a cloned
// project, or was changed outside Rearview, is shown in the pane but ignored until the person approves it.

import type { EngineInterface } from 'claude-code'

import { readProjectFile, writeProjectFile } from './paths'
import type { Principle, PrincipleSet, Signal } from '../types'

export const PRINCIPLES_FILE = '.claude/rearview/principles.md'
export const SIGNALS_FILE = '.claude/rearview/signals.jsonl'

const FILE_HEADER = `# Rearview principles

Rules Claude reads before it works. Edit them freely: keep to this format,
because Rearview rewrites this file when you approve or retire a principle.
Each section is one principle. enforce: guide | warn | block. status: active | retired.
files: an optional glob (e.g. package.json, src/**/*.css) Claude may not edit while enforce is block.
`

/** Reads principles.md, trusted only if its contents match what was last written or approved here. */
export async function loadPrinciples($: EngineInterface): Promise<PrincipleSet> {
  const text = await readProjectFile($, PRINCIPLES_FILE)
  if (text === null) return { list: [], isTrusted: true }
  const approved = await $.store.get(await trustStoreKey($))
  return { list: parsePrinciples(text), isTrusted: approved === (await fingerprint(text)) }
}

/** Writes principles.md and records its contents as approved. */
export async function savePrinciples($: EngineInterface, list: Principle[]): Promise<PrincipleSet> {
  const text = formatPrinciples(list)
  await writeProjectFile($, PRINCIPLES_FILE, text)
  await $.store.set(await trustStoreKey($), await fingerprint(text))
  return { list, isTrusted: true }
}

/** The person approved principles.md as it is on disk now. */
export async function trustPrinciples($: EngineInterface): Promise<PrincipleSet> {
  const text = await readProjectFile($, PRINCIPLES_FILE)
  if (text === null) return { list: [], isTrusted: true }
  await $.store.set(await trustStoreKey($), await fingerprint(text))
  return { list: parsePrinciples(text), isTrusted: true }
}

/** The principles that may be used: none while the file is not approved. */
export function usablePrinciples(set: PrincipleSet): Principle[] {
  return set.isTrusted ? set.list : []
}

async function trustStoreKey($: EngineInterface): Promise<string> {
  return `principles-approved:v1:${await $.session.root()}`
}

/** SHA-256 of the file's text, as hex. */
async function fingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Parses `## id` sections with `- field: value` lines. Unknown fields are ignored. */
export function parsePrinciples(markdown: string): Principle[] {
  const sections = markdown.split(/^## /m).slice(1)
  return sections
    .map(section => {
      const [heading = '', ...lines] = section.split('\n')
      const field = (name: string) =>
        lines.find(line => line.startsWith(`- ${name}:`))?.slice(name.length + 3).trim() ?? ''
      const enforce = field('enforce')
      return {
        id: heading.trim(),
        rule: field('rule'),
        scope: field('scope') || 'everywhere',
        enforce: enforce === 'warn' || enforce === 'block' ? enforce : 'guide',
        files: field('files'),
        status: field('status') === 'retired' ? 'retired' : 'active',
        signals: Number(field('signals')) || 0,
      } satisfies Principle
    })
    .filter(principle => principle.id !== '' && principle.rule !== '')
}

export function formatPrinciples(list: Principle[]): string {
  const sections = list.map(p =>
    [
      `## ${p.id}`,
      `- rule: ${p.rule}`,
      `- scope: ${p.scope}`,
      `- enforce: ${p.enforce}`,
      `- files: ${p.files}`,
      `- status: ${p.status}`,
      `- signals: ${p.signals}`,
    ].join('\n'),
  )
  return [FILE_HEADER, ...sections].join('\n\n') + '\n'
}

/** The system-prompt text for active principles, or null when there are none. */
export function principlesPromptSection(list: Principle[]): string | null {
  const active = list.filter(p => p.status === 'active')
  if (active.length === 0) return null
  const lines = active.map(p => `- ${oneLine(p.rule)}${p.scope === 'everywhere' ? '' : ` (applies: ${oneLine(p.scope)})`}`)
  return `The person you work with has these standing preferences. Follow them unless they say otherwise:\n${lines.join('\n')}`
}

/** A rule as one short line of plain text: control characters removed, at most 300 characters. */
function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
}

/** The active blocking principle whose `files` glob matches `path`, if any. */
export function blockingPrinciple(list: Principle[], path: string): Principle | undefined {
  return list.find(p => p.status === 'active' && p.enforce === 'block' && p.files !== '' && matchesGlob(p.files, path))
}

/**
 * `*` matches within a folder, `**` across folders. A pattern with no `/` also matches the file name alone.
 * Patterns longer than 200 characters or with more than four `**` match nothing, so a hand-written
 * pattern can never make matching slow.
 */
export function matchesGlob(pattern: string, path: string): boolean {
  if (pattern.length > 200 || pattern.split('**').length - 1 > 4) return false
  const regex = new RegExp(
    '^' +
      pattern
        .split('**')
        .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
        .join('.*') +
      '$',
  )
  const name = path.split('/').pop() ?? path
  return regex.test(path) || (!pattern.includes('/') && regex.test(name))
}

/** A short id for a new principle, made from its rule: "Always add tests" -> "always-add-tests". */
export function principleId(rule: string, taken: Principle[]): string {
  const base = rule.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'principle'
  let id = base
  for (let n = 2; taken.some(p => p.id === id); n++) id = `${base}-${n}`
  return id
}

/**
 * Asks the quick-check model whether `prompt` asks Claude to act against an active principle.
 * Returns that principle, or null. Any failure counts as "no conflict" so a prompt is never lost.
 */
export async function findDrift(
  $: EngineInterface,
  prompt: string,
  list: Principle[],
  model: string,
): Promise<Principle | null> {
  const active = list.filter(p => p.status === 'active')
  if (active.length === 0) return null

  const reply = await $.model.complete({
    model,
    maxTokens: 100,
    timeoutMs: 8000,
    system: 'You compare a request to an AI coding agent against the person\'s standing principles. Reply with JSON only.',
    prompt:
      `PRINCIPLES:\n${active.map(p => `[${p.id}] ${p.rule} (applies: ${p.scope})`).join('\n')}\n\n` +
      `REQUEST:\n${prompt}\n\n` +
      'Does the request explicitly ask the agent to do something a principle forbids, or to skip something a principle requires? ' +
      'Only count a clear conflict, not a request that is merely unrelated. Reply {"conflict": "<principle id>"} or {"conflict": null}.',
  })
  if (!reply.isAnswered) return null
  const conflictId = parseJsonObject(reply.text)?.conflict
  return active.find(p => p.id === conflictId) ?? null
}

/** Appends one approval or steer to signals.jsonl. */
export async function recordSignal($: EngineInterface, signal: Signal): Promise<void> {
  const previous = (await readProjectFile($, SIGNALS_FILE)) ?? ''
  await writeProjectFile($, SIGNALS_FILE, `${previous}${JSON.stringify(signal)}\n`)
}

export async function loadSignals($: EngineInterface): Promise<Signal[]> {
  const text = (await readProjectFile($, SIGNALS_FILE)) ?? ''
  return text
    .split('\n')
    .filter(line => line.trim() !== '')
    .flatMap(line => {
      try {
        return [JSON.parse(line) as Signal]
      } catch {
        return []
      }
    })
}

/**
 * When at least two steers express the same lasting preference, returns it as one short rule
 * the person can approve, with how many steers say it. Returns null otherwise, or when an
 * existing principle already says it.
 */
export async function suggestRule(
  $: EngineInterface,
  signals: Signal[],
  list: Principle[],
  model: string,
): Promise<{ rule: string; steers: number } | null> {
  const steers = signals.filter(s => s.kind === 'steer').slice(-20)
  if (steers.length < 2) return null

  const reply = await $.model.complete({
    model,
    maxTokens: 150,
    timeoutMs: 10000,
    system: 'You find lasting preferences in corrections a person gave an AI coding agent. Reply with JSON only.',
    prompt:
      `CORRECTIONS:\n${steers.map(s => `- (${s.step}) ${s.text}`).join('\n')}\n\n` +
      `EXISTING PRINCIPLES:\n${list.map(p => `- ${p.rule}`).join('\n') || '(none)'}\n\n` +
      'If two or more corrections express the same preference that would apply to future work, and no existing principle says it, ' +
      'write it as one rule of at most 12 words and count the corrections that say it. ' +
      'Reply {"rule": "...", "count": 2} or {"rule": null}.',
  })
  if (!reply.isAnswered) return null
  const json = parseJsonObject(reply.text)
  const rule = typeof json?.rule === 'string' ? json.rule.trim() : ''
  return rule === '' ? null : { rule, steers: typeof json?.count === 'number' ? json.count : 2 }
}

/** Parses the first JSON object in a model reply, ignoring code fences. Returns null when there is none. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}
