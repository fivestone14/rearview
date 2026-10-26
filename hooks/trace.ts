// Finding where names are defined and used, and which files import which, with git grep.

import type { EngineInterface } from 'claude-code'

import { readProjectFile, runInProject } from './paths'
import type { TraceHit, TraceResult } from '../types'

/** Trace shows at most this many lines. */
const MAX_TRACE_HITS = 40

/** Lines that look like a definition of `symbol` in common languages. */
const definitionPattern = (symbol: string) =>
  new RegExp(
    `\\b(function|class|interface|type|enum|const|let|var|def|fn|func|struct)\\s+${escapeRegExp(symbol)}\\b`,
  )

/** Finds every line in the project that mentions `symbol`, split into definitions and uses. */
export async function traceSymbol($: EngineInterface, symbol: string): Promise<TraceResult> {
  const hits = (await grepWord($, symbol)).slice(0, MAX_TRACE_HITS)
  const isDefinition = definitionPattern(symbol)
  return {
    symbol,
    definitions: hits.filter(hit => isDefinition.test(hit.text)),
    uses: hits.filter(hit => !isDefinition.test(hit.text)),
  }
}

/**
 * Files that import `file` (relative imports only). Names shorter than 3 characters are not searched:
 * they match nearly every line of a project and would make the search slow for no useful answer.
 */
export async function findImporters($: EngineInterface, file: string): Promise<string[]> {
  const stem = fileStem(file)
  if (stem.length < 3) return []
  const hits = await grepWord($, stem)
  const importers = hits
    .filter(hit => hit.file !== file)
    .filter(hit => parseImports(hit.text).some(spec => resolveImport(hit.file, spec) === withoutExtension(file)))
    .map(hit => hit.file)
  return [...new Set(importers)]
}

/** Project files that `file` imports (relative imports only, returned without extension). */
export async function findImports($: EngineInterface, file: string): Promise<string[]> {
  const specs = parseImports((await readProjectFile($, file)) ?? '')
  return [...new Set(specs.map(spec => resolveImport(file, spec)).filter((path): path is string => path !== null))]
}

/** The module paths an import line (or file) names: JS/TS `import … from`, `require()`, and Python `from x import`. */
export function parseImports(source: string): string[] {
  const specs: string[] = []
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*from\s+(\.+\w[\w.]*)\s+import\b/gm,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specs.push(match[1]!)
  }
  // Python `from . import theme` imports the module `.theme`.
  for (const match of source.matchAll(/^\s*from\s+(\.+)\s+import\s+(\w+)/gm)) specs.push(match[1]! + match[2]!)
  return specs
}

/**
 * Turns a relative import into a project path without extension, e.g.
 * `src/settings/Panel.tsx` + `../theme/Theme` -> `src/theme/Theme`. Package imports return null.
 */
export function resolveImport(fromFile: string, spec: string): string | null {
  const isPython = /^\.+[\w.]*$/.test(spec) && !spec.includes('/')
  const relative = isPython ? pythonToPath(spec) : spec
  if (!relative.startsWith('.')) return null

  const parts = fromFile.split('/').slice(0, -1)
  for (const part of relative.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return withoutExtension(parts.join('/'))
}

/** `..theme.colors` (Python) -> `../theme/colors` */
function pythonToPath(spec: string): string {
  const dots = spec.match(/^\.+/)![0].length
  const rest = spec.slice(dots).replace(/\./g, '/')
  const up = dots === 1 ? './' : '../'.repeat(dots - 1)
  return up + rest
}

function withoutExtension(path: string): string {
  return path.replace(/\.(tsx?|jsx?|mjs|cjs|py)$/, '').replace(/\/index$/, '')
}

function fileStem(path: string): string {
  const name = withoutExtension(path).split('/').pop() ?? path
  return name
}

/** Runs `git grep -n -w` (untracked files included), or plain grep when the project is not a git repository. */
async function grepWord($: EngineInterface, word: string): Promise<TraceHit[]> {
  let run = await runInProject($, ['git', 'grep', '--untracked', '-n', '-w', '-I', '-F', '--', word])
  if (run.exitCode === 128) {
    run = await runInProject($, [
      'grep', '-rnwIF', '--exclude-dir=.git', '--exclude-dir=node_modules', '--', word, '.',
    ])
  }
  // Exit code 1 means "no matches", which is an empty answer, not an error.
  if (run.exitCode !== 0) return []
  return run.stdout
    .split('\n')
    .map(parseGrepLine)
    .filter((hit): hit is TraceHit => hit !== null)
}

/** `src/a.ts:12:const x = 1` -> { file, line, text } */
function parseGrepLine(line: string): TraceHit | null {
  const match = line.match(/^(?:\.\/)?([^:]+):(\d+):(.*)$/)
  if (!match) return null
  return { file: match[1]!, line: Number(match[2]), text: match[3]!.trim() }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
