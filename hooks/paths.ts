// Rearview keeps every path relative to the project root (as git prints them) and turns them
// into absolute paths only when it reads, writes or runs something.

import type { EngineInterface, ProcessRunResult } from 'claude-code'

/** Files larger than this are not diffed or read. */
const MAX_FILE_CHARS = 500_000
/** A git or grep command that runs longer than this is given up on. */
const COMMAND_TIMEOUT_MS = 15_000

/**
 * File names that usually hold secrets: .env files, private keys, credential stores.
 * Rearview lists these by name but never reads them, so their contents are never shown, stored or sent.
 */
const SECRET_FILE =
  /(^|\/)(\.env(\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.htpasswd|\.dockercfg|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|[^/]*service[-_]?account[^/]*\.json|[^/]*\.(pem|key|p12|pfx|jks|keystore|kdbx|tfstate|tfstate\.backup))$/i

export function looksLikeSecretFile(path: string): boolean {
  return SECRET_FILE.test(path)
}

/** `/repo/src/a.ts` -> `src/a.ts` (paths outside the project are kept as they are). */
export async function projectPath($: EngineInterface, path: string): Promise<string> {
  const root = await $.session.root()
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}

/** `src/a.ts` -> `/repo/src/a.ts` */
export async function absolutePath($: EngineInterface, path: string): Promise<string> {
  return path.startsWith('/') ? path : `${await $.session.root()}/${path}`
}

/** SHA-256 of a text, as 64 hex characters. */
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * A key for Rearview's plugin store that belongs to this project, e.g. `turns:v1:3f2a…`.
 * The project path is hashed because store keys are limited to 256 characters.
 */
export async function projectStoreKey($: EngineInterface, name: string): Promise<string> {
  return `${name}:${await sha256(await $.session.root())}`
}

/** Reads a project file's text, or null when it is missing, too large, or binary. */
export async function readProjectFile($: EngineInterface, path: string): Promise<string | null> {
  try {
    const absolute = await absolutePath($, path)
    if (!(await $.fs.exists(absolute))) return null
    const text = await $.fs.read(absolute)
    const isUsable = typeof text === 'string' && text.length <= MAX_FILE_CHARS && !text.includes('\0')
    return isUsable ? text : null
  } catch {
    return null
  }
}

export async function writeProjectFile($: EngineInterface, path: string, text: string): Promise<void> {
  await $.fs.write(await absolutePath($, path), text)
}

/**
 * Runs a command in the project root, so git prints paths relative to it.
 * A command that cannot start (git not installed) or times out answers exit code -1.
 */
export async function runInProject($: EngineInterface, argv: string[]): Promise<ProcessRunResult> {
  try {
    return await $.process.run(argv, { cwd: await $.session.root(), timeoutMs: COMMAND_TIMEOUT_MS })
  } catch (error) {
    const stderr = error instanceof Error ? error.message : String(error)
    return { exitCode: -1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false }
  }
}
