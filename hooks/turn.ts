// Recording a turn: the request, the files Claude read and changed, the diff of each change,
// and what Claude wrote while it worked.
//
// Edits made through Claude's file tools are diffed exactly: the file is read before its first edit
// and again when the turn ends. Shell commands bypass those tools, so in a git repository the turn
// also takes a snapshot of the working tree when it starts and compares against it when it ends.

import type { EngineInterface } from 'claude-code'

import { exportTurns } from './bridge'
import { unifiedDiff } from './diff'
import { looksLikeSecretFile, projectPath, projectStoreKey, readProjectFile, runInProject } from './paths'
import { getActiveTurn, getTurns, updateActiveTurn, updateTurns } from './state'
import { findImporters } from './trace'
import type { ActiveTurn, ChangedFile, Turn } from '../types'

/** Claude's tools that change a file, and the input field holding its path. */
const EDIT_TOOLS: Record<string, string> = {
  Edit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
}
const MAX_STORED_TURNS = 20
/** At most this many shell-changed files are diffed per turn. */
const MAX_SHELL_FILES = 50
/** Importers are searched for at most this many changed files per turn, so a huge change cannot stall the end of a turn. */
const MAX_FILES_TRACED_FOR_IMPORTERS = 10
const MAX_AGENT_TEXT_CHARS = 12_000
/**
 * Prompt origins that are the person's own request, typed or sent on their behalf. Every other origin
 * (a task notification, another session's message, a relay, an idle notice) is a system message.
 */
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping', 'plugin', 'auto-continuation', 'scheduled-trigger', 'unknown'])

export function isSystemOrigin(origin: string): boolean {
  return !PERSON_ORIGINS.has(origin)
}

export async function startTurn($: EngineInterface, request: string, origin: string): Promise<void> {
  const turn: ActiveTurn = {
    id: crypto.randomUUID(),
    request,
    filesRead: [],
    before: {},
    secretFiles: [],
    gitBase: await gitSnapshot($),
    untrackedBefore: await untrackedFiles($),
    messageCount: (await $.session.messages()).length,
    origin,
  }
  await updateActiveTurn($, () => turn)
}

/** The file a tool call is about to change, or null when the tool does not edit files. */
export function editedPath(tool: string, input: Record<string, unknown>): string | null {
  const field = EDIT_TOOLS[tool]
  const path = field ? input[field] : undefined
  return typeof path === 'string' ? path : null
}

/**
 * Called before each tool runs. Remembers files Claude reads, and the content of a file
 * before Claude's first edit to it in this turn.
 */
export async function noteToolCall($: EngineInterface, tool: string, input: Record<string, unknown>): Promise<void> {
  const turn = await getActiveTurn($)
  if (!turn) return

  if (tool === 'Read' && typeof input.file_path === 'string') {
    const path = await projectPath($, input.file_path)
    if (!turn.filesRead.includes(path)) {
      await updateActiveTurn($, t => (t ? { ...t, filesRead: [...t.filesRead, path] } : t))
    }
    return
  }

  const rawPath = editedPath(tool, input)
  if (rawPath === null) return
  const path = await projectPath($, rawPath)
  if (looksLikeSecretFile(path)) {
    if (!turn.secretFiles.includes(path)) {
      await updateActiveTurn($, t => (t ? { ...t, secretFiles: [...t.secretFiles, path] } : t))
    }
    return
  }
  if (path in turn.before) return

  const original = await readProjectFile($, path)
  await updateActiveTurn($, t => (t && !(path in t.before) ? { ...t, before: { ...t.before, [path]: original } } : t))
}

/** Called when Claude finishes. Turns the active turn into a finished Turn whose review is pending. */
export async function finishTurn($: EngineInterface, answer: string, endReason: Turn['endReason']): Promise<void> {
  const active = await getActiveTurn($)
  if (!active) return
  try {
    const files = [...(await changedByTools($, active)), ...active.secretFiles.map(secretFile)]
    files.push(...(await changedByShell($, active, new Set([...files.map(f => f.path), ...Object.keys(active.before)]))))
    // A system message that changed nothing is noise; one that changed files is kept, so no edit escapes review.
    const isSystem = isSystemOrigin(active.origin)
    if (isSystem && files.length === 0) return
    const turn: Turn = {
      id: active.id,
      request: active.request,
      answer,
      agentMessages: await agentTextSince($, active.messageCount),
      endReason,
      ...(isSystem ? { origin: active.origin } : {}),
      finishedAt: Date.now(),
      filesRead: active.filesRead,
      files,
      affected: await affectedFiles($, files),
      review: files.length > 0 ? { state: 'pending' } : { state: 'skipped', reason: 'Nothing was changed in this turn.' },
    }
    await updateTurns($, list => [...list, turn].slice(-MAX_STORED_TURNS))
    await saveTurns($)
  } finally {
    await updateActiveTurn($, () => null)
  }
}

async function changedByTools($: EngineInterface, active: ActiveTurn): Promise<ChangedFile[]> {
  const files: ChangedFile[] = []
  for (const [path, before] of Object.entries(active.before)) {
    const after = await readProjectFile($, path)
    const { diff, added, removed } = unifiedDiff(path, before, after)
    if (diff === '') continue
    const change = before === null ? 'new' : after === null ? 'deleted' : 'edited'
    files.push({ path, change, diff, added, removed })
  }
  return files
}

/**
 * Files changed during the turn without Claude's file tools: tracked files that differ from the
 * snapshot taken at the start, and untracked files that were not there at the start.
 * `--relative` keeps git to the project folder and prints paths relative to it, even when the
 * project is a subfolder of a larger repository.
 */
async function changedByShell($: EngineInterface, active: ActiveTurn, known: Set<string>): Promise<ChangedFile[]> {
  const files: ChangedFile[] = []

  if (active.gitBase) {
    const names = await runInProject($, ['git', 'diff', '--relative', '--name-only', '-z', active.gitBase])
    for (const path of names.stdout.split('\0').filter(Boolean)) {
      if (files.length >= MAX_SHELL_FILES) return files
      if (known.has(path)) continue
      if (looksLikeSecretFile(path)) {
        files.push(secretFile(path))
        continue
      }
      const run = await runInProject($, ['git', 'diff', '--relative', active.gitBase, '--', path])
      const change = fromGitDiff(path, run.stdout)
      if (change.diff !== '') files.push(change)
    }
  }

  const untrackedBefore = new Set(active.untrackedBefore)
  for (const path of await untrackedFiles($)) {
    if (files.length >= MAX_SHELL_FILES) return files
    if (known.has(path) || untrackedBefore.has(path)) continue
    if (looksLikeSecretFile(path)) {
      files.push(secretFile(path))
      continue
    }
    const text = await readProjectFile($, path)
    // A binary or very large new file is listed by name, without a diff.
    const diff = text === null ? { diff: '', added: 0, removed: 0 } : unifiedDiff(path, null, text)
    files.push({ path, change: 'shell', ...diff })
  }

  return files
}

/** A changed file that looks like it holds secrets: listed by name, contents never read. */
function secretFile(path: string): ChangedFile {
  return { path, change: 'edited', diff: '', added: 0, removed: 0, isSecret: true }
}

/** Keeps git's diff from its `---` line on (dropping the `diff --git` header) and counts its lines. */
function fromGitDiff(path: string, gitDiff: string): ChangedFile {
  const lines = gitDiff.split('\n')
  const start = lines.findIndex(line => line.startsWith('---'))
  if (start === -1) return { path, change: 'shell', diff: '', added: 0, removed: 0 }
  const body = lines.slice(start + 2)
  return {
    path,
    change: 'shell',
    diff: lines.slice(start).join('\n'),
    added: body.filter(line => line.startsWith('+')).length,
    removed: body.filter(line => line.startsWith('-')).length,
  }
}

/**
 * A commit holding the working tree as it is now, without touching your files or branches:
 * `git stash create` makes one when there are uncommitted changes and prints nothing when there
 * are none, in which case HEAD is the same thing. Null when git cannot snapshot (outside git,
 * before the first commit, or mid-merge), so old changes are never reported as new.
 */
async function gitSnapshot($: EngineInterface): Promise<string | null> {
  const stash = await runInProject($, ['git', 'stash', 'create'])
  if (stash.exitCode !== 0) return null
  if (stash.stdout.trim() !== '') return stash.stdout.trim()
  const head = await runInProject($, ['git', 'rev-parse', '--verify', '--quiet', 'HEAD'])
  return head.exitCode === 0 && head.stdout.trim() !== '' ? head.stdout.trim() : null
}

/** Untracked files git does not ignore. Empty outside a git repository. */
async function untrackedFiles($: EngineInterface): Promise<string[]> {
  const run = await runInProject($, ['git', 'ls-files', '--others', '--exclude-standard', '-z'])
  return run.exitCode === 0 ? run.stdout.split('\0').filter(Boolean) : []
}

/** Files that import a changed file but were not changed themselves. */
async function affectedFiles($: EngineInterface, files: ChangedFile[]): Promise<string[]> {
  const changed = new Set(files.map(f => f.path))
  const affected = new Set<string>()
  for (const file of files.filter(f => !f.isSecret).slice(0, MAX_FILES_TRACED_FOR_IMPORTERS)) {
    for (const importer of await findImporters($, file.path)) {
      if (!changed.has(importer)) affected.add(importer)
    }
  }
  return [...affected]
}

/** What Claude wrote in the conversation rows added since the turn started. */
async function agentTextSince($: EngineInterface, rowsBefore: number): Promise<string> {
  const rows = await $.session.messages()
  const text = rows
    .slice(rowsBefore)
    .filter(row => row.role === 'assistant' && row.text.trim() !== '')
    .map(row => row.text.trim())
    .join('\n---\n')
  return text.length <= MAX_AGENT_TEXT_CHARS ? text : `${text.slice(0, MAX_AGENT_TEXT_CHARS)}\n[... more left out]`
}

/** The key holds the version of the Turn shape, so turns saved by an older version are not misread. */
async function turnsStoreKey($: EngineInterface): Promise<string> {
  return projectStoreKey($, 'turns:v1')
}

/** Keeps finished turns across sessions, per project, and shares them with the Obsidian view. */
export async function saveTurns($: EngineInterface): Promise<void> {
  const turns = await getTurns($)
  await $.store.set(await turnsStoreKey($), turns)
  await exportTurns($, turns)
}

export async function loadTurns($: EngineInterface): Promise<void> {
  const saved = await $.store.get(await turnsStoreKey($))
  if (Array.isArray(saved)) await updateTurns($, () => saved as Turn[])
}
