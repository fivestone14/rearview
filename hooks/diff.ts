// Line diffs in the unified format git prints (`@@ -1,3 +1,4 @@`), computed in memory.

export type LineDiff = { diff: string; added: number; removed: number }

type Op = { kind: 'same' | 'add' | 'remove'; text: string }

/** Lines of unchanged code shown around each change. */
const CONTEXT_LINES = 3
/** Above this many table cells (old lines x new lines) we skip line matching and show a full replace. */
const MAX_TABLE_CELLS = 4_000_000

/**
 * Builds a unified diff between two versions of one file.
 * `before` null means the file is new; `after` null means it was deleted.
 */
export function unifiedDiff(path: string, before: string | null, after: string | null): LineDiff {
  const ops = diffLines(splitLines(before), splitLines(after))
  const added = ops.filter(op => op.kind === 'add').length
  const removed = ops.filter(op => op.kind === 'remove').length
  if (added === 0 && removed === 0) return { diff: '', added, removed }

  const oldName = before === null ? '/dev/null' : `a/${path}`
  const newName = after === null ? '/dev/null' : `b/${path}`
  const hunks = buildHunks(ops)
  return { diff: [`--- ${oldName}`, `+++ ${newName}`, ...hunks].join('\n') + '\n', added, removed }
}

function splitLines(text: string | null): string[] {
  if (text === null || text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Matches lines with a longest-common-subsequence table, then walks it into same/add/remove steps. */
function diffLines(oldLines: string[], newLines: string[]): Op[] {
  const n = oldLines.length
  const m = newLines.length
  if (n * m > MAX_TABLE_CELLS) {
    return [
      ...oldLines.map(text => ({ kind: 'remove' as const, text })),
      ...newLines.map(text => ({ kind: 'add' as const, text })),
    ]
  }

  // common[i][j] = length of the longest common subsequence of oldLines[i..] and newLines[j..]
  const common = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      common[i]![j] = oldLines[i] === newLines[j]
        ? common[i + 1]![j + 1]! + 1
        : Math.max(common[i + 1]![j]!, common[i]![j + 1]!)
    }
  }

  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && oldLines[i] === newLines[j]) {
      ops.push({ kind: 'same', text: oldLines[i]! })
      i++
      j++
    } else if (i < n && (j === m || common[i + 1]![j]! >= common[i]![j + 1]!)) {
      // Removals come before additions, as git prints them.
      ops.push({ kind: 'remove', text: oldLines[i]! })
      i++
    } else {
      ops.push({ kind: 'add', text: newLines[j]! })
      j++
    }
  }
  return ops
}

/** Groups changed lines (plus a few lines of context) into `@@` hunks. */
function buildHunks(ops: Op[]): string[] {
  // Line numbers of each op in the old and new file, counted before the op.
  const oldAt: number[] = []
  const newAt: number[] = []
  let oldLine = 1
  let newLine = 1
  for (const op of ops) {
    oldAt.push(oldLine)
    newAt.push(newLine)
    if (op.kind !== 'add') oldLine++
    if (op.kind !== 'remove') newLine++
  }

  // Ranges of op indexes to print, widened by the context and merged when they touch.
  const ranges: Array<[number, number]> = []
  ops.forEach((op, index) => {
    if (op.kind === 'same') return
    const start = Math.max(0, index - CONTEXT_LINES)
    const end = Math.min(ops.length - 1, index + CONTEXT_LINES)
    const last = ranges[ranges.length - 1]
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
    else ranges.push([start, end])
  })

  return ranges.flatMap(([start, end]) => {
    const slice = ops.slice(start, end + 1)
    const oldCount = slice.filter(op => op.kind !== 'add').length
    const newCount = slice.filter(op => op.kind !== 'remove').length
    // git writes a zero-length side as starting on the line before it.
    const oldStart = oldCount === 0 ? oldAt[start]! - 1 : oldAt[start]!
    const newStart = newCount === 0 ? newAt[start]! - 1 : newAt[start]!
    const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`
    const sign = { same: ' ', add: '+', remove: '-' } as const
    return [header, ...slice.map(op => sign[op.kind] + op.text)]
  })
}
