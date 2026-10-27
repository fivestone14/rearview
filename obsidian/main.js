// Rearview for Obsidian: shows the turns Rearview recorded in Claude Code, read from each project's
// .claude/rearview/turns.json, and sends steers back through .claude/rearview/inbox.jsonl.
//
//   left sidebar  -> the turns of every connected project, newest first, with their check score
//   main tab      -> the selected turn: your request, then Code / Check work / Reasoning
//   right sidebar -> the turn's files, Trace, and a box to steer Claude's next turn
//
// Desktop only: project folders sit outside the vault, so they are read with Node's fs,
// and Trace runs git grep (an argument list, never a shell) in the project.

const { ItemView, Modal, Notice, Plugin, PluginSettingTab, Setting } = require('obsidian')
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

const TURNS_VIEW = 'rearview-turns'
const TURN_VIEW = 'rearview-turn'
const SIDE_VIEW = 'rearview-side'
const DATA_DIR = path.join('.claude', 'rearview')
/** How often each project's turns.json is checked for changes. */
const WATCH_MS = 1500
/** A file's diff shows at most this many lines. */
const MAX_DIFF_LINES = 400
const MAX_TRACE_HITS = 40
/** The same names Rearview treats as secrets (hooks/paths.ts): Trace never shows their lines. */
const SECRET_FILE =
  /(^|\/)(\.env(\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.htpasswd|\.dockercfg|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|[^/]*service[-_]?account[^/]*\.json|[^/]*\.(pem|key|p12|pfx|jks|keystore|kdbx|tfstate|tfstate\.backup))$/i

const DEFAULT_SETTINGS = { projects: [], openOnNewTurn: true }

const SOURCES = {
  stated: { label: 'Claude said so', tone: 'blue' },
  inferred: { label: 'Inferred', tone: 'green' },
  none: { label: 'No reason found', tone: 'muted' },
}
const STATUS_TONES = { done: 'green', partly: 'orange', missed: 'red' }
const STEP_TONES = { plan: 'muted', explored: 'muted', decision: 'blue', shortcut: 'orange', unrequested: 'purple', skipped: 'red' }
const CHANGE_LABELS = {
  new: ['New file', 'green'],
  edited: ['Edited', 'muted'],
  deleted: ['Deleted', 'red'],
  shell: ['Changed by a command', 'muted'],
}

// ---------- reading Rearview's data ----------

/** A unified diff as rows: hunk headers, and added, removed and unchanged lines with their line numbers. */
function parseDiff(diff) {
  const rows = []
  let oldNo = 0
  let newNo = 0
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('--- ') || raw.startsWith('+++ ')) continue
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      rows.push({ kind: 'hunk', text: raw })
    } else if (raw.startsWith('+')) rows.push({ kind: 'add', text: raw.slice(1), newNo: newNo++ })
    else if (raw.startsWith('-')) rows.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++ })
    else if (raw.startsWith(' ')) rows.push({ kind: 'same', text: raw.slice(1), newNo: newNo++, oldNo: oldNo++ })
  }
  return rows
}

/** The short label beside a turn: its check score, or why it has none. */
function score(turn) {
  const review = turn.review || {}
  if (review.state === 'pending') return { label: 'reviewing', tone: 'muted' }
  if (turn.isGit) return { label: turn.files ? `${turn.files.length} files` : 'commit', tone: 'muted' }
  if (review.state === 'failed') return { label: 'review failed', tone: 'red' }
  if (review.state !== 'done') return { label: turn.files.length ? 'not reviewed' : 'no edits', tone: 'muted' }
  const reqs = review.result.requirements
  if (reqs.length === 0) return { label: 'reviewed', tone: 'muted' }
  const done = reqs.filter(r => r.status === 'done').length
  return { label: `${done}/${reqs.length}`, tone: done === reqs.length ? 'green' : done * 2 >= reqs.length ? 'orange' : 'red' }
}

/** A turn's first line, without the `<tag>…</tag>` blocks Claude Code wraps around context it adds to a request. */
function titleOf(request) {
  const text = (request || '').replace(/<([a-z][\w-]*)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
  const first = text.split('\n').map(line => line.trim()).find(Boolean) || ''
  return first.length > 60 ? `${first.slice(0, 57)}…` : first || '(no request text)'
}

/** `src/a.ts:12:const x = 1` -> { file, line, text } */
function parseGrepLine(line) {
  const match = line.match(/^(?:\.\/)?([^:]+):(\d+):(.*)$/)
  return match ? { file: match[1], line: Number(match[2]), text: match[3].trim() } : null
}

// ---------- Git: checking the connection, and the changes it tracks ----------

/** How often each project's Git status is checked for new changes. */
const GIT_POLL_MS = 4000
/** The Git section lists this many recent commits. */
const MAX_COMMITS = 15
/** At most this many untracked files are shown as new files. */
const MAX_UNTRACKED = 50

/** Runs git with an argument list (never a shell); always resolves { code, stdout, stderr }. */
function runGit(cwd, args, timeout = 15000) {
  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || (error && error.message) || '') })
    })
  })
}

/** `https://github.com/me/app.git` or `git@github.com:me/app.git` -> `me/app`; other hosts give null. */
function githubRepo(url) {
  const match = url.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/)
  return match ? match[1] : null
}

/**
 * Checks that a folder can be followed through Git, step by step, the way the import shows it.
 * Each step is ok, warn (works, with less) or fail (cannot be imported). `root` is the repository's top folder.
 */
async function checkGitConnection(folder) {
  const steps = []
  const add = (label, status, detail) => steps.push({ label, status, detail })
  const result = { steps, root: null, branch: null, isOk: false }
  try {
    if (!(await fs.promises.stat(folder)).isDirectory()) throw new Error('not a folder')
    add('Folder', 'ok', folder)
  } catch {
    add('Folder', 'fail', 'There is no folder at this path.')
    return result
  }
  const version = await runGit(folder, ['--version'])
  if (version.code !== 0) {
    add('Git installed', 'fail', 'git could not be run. Install Git, then try again.')
    return result
  }
  add('Git installed', 'ok', version.stdout.trim())
  const top = await runGit(folder, ['rev-parse', '--show-toplevel'])
  if (top.code !== 0) {
    add('Git repository', 'fail', 'This folder is not inside a Git repository. Run git init there first.')
    return result
  }
  result.root = top.stdout.trim()
  add('Git repository', 'ok', result.root)
  const branch = (await runGit(result.root, ['branch', '--show-current'])).stdout.trim()
  const last = await runGit(result.root, ['log', '-1', '--format=%h %s'])
  result.branch = branch || 'detached HEAD'
  add('Branch and last commit', 'ok', last.code === 0 ? `${result.branch} · ${last.stdout.trim()}` : `${result.branch} · no commits yet`)
  result.isOk = true

  const remote = await runGit(result.root, ['remote', 'get-url', 'origin'])
  if (remote.code !== 0) {
    add('Remote', 'warn', 'No remote named origin: changes are followed on this computer only.')
    return result
  }
  const url = remote.stdout.trim()
  const repo = githubRepo(url)
  add('Remote', 'ok', repo ? `GitHub · ${repo}` : url)
  const reach = await runGit(result.root, ['ls-remote', '--heads', 'origin'], 20000)
  add(repo ? 'GitHub reachable' : 'Remote reachable', reach.code === 0 ? 'ok' : 'warn', reach.code === 0 ? `${reach.stdout.trim().split('\n').filter(Boolean).length} branches seen` : 'Could not reach it (offline, or not signed in). Local changes still work.')
  const counts = await runGit(result.root, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])
  if (counts.code === 0) {
    const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number)
    add('In step with the remote', 'ok', `${ahead} ahead, ${behind} behind`)
  } else {
    add('In step with the remote', 'warn', 'This branch has no upstream yet, so ahead and behind are unknown.')
  }
  return result
}

/** `git diff` / `git show` output as Rearview's changed files; secret-looking files keep their name only. */
function parseGitPatch(patch) {
  const files = []
  let file = null
  for (const line of patch.split('\n')) {
    const header = line.match(/^diff --git a\/(.+) b\/(.+)$/)
    if (header) {
      file = { path: header[2], change: 'edited', lines: [], added: 0, removed: 0, inHunks: false }
      files.push(file)
      continue
    }
    if (!file) continue
    if (!file.inHunks) {
      if (line.startsWith('new file mode')) file.change = 'new'
      else if (line.startsWith('deleted file mode')) file.change = 'deleted'
      else if (line.startsWith('+++ b/')) file.path = line.slice(6)
      else if (line.startsWith('rename to ')) file.path = line.slice(10)
    }
    if (line.startsWith('@@')) file.inHunks = true
    if (!file.inHunks) continue
    file.lines.push(line)
    if (line.startsWith('+')) file.added++
    else if (line.startsWith('-')) file.removed++
  }
  return files.map(f => {
    const isSecret = SECRET_FILE.test(f.path)
    const changed = { path: f.path, change: f.change, diff: isSecret ? '' : f.lines.join('\n'), added: f.added, removed: f.removed }
    return isSecret ? { ...changed, isSecret: true } : changed
  })
}

/** An untracked file as a new file with an all-added diff; secrets, binary and large files keep their name only. */
async function untrackedFile(root, file) {
  const changed = { path: file, change: 'new', diff: '', added: 0, removed: 0 }
  if (SECRET_FILE.test(file)) return { ...changed, isSecret: true }
  try {
    const absolute = path.join(root, file)
    if ((await fs.promises.stat(absolute)).size > MAX_MAP_FILE_BYTES) return changed
    const text = await fs.promises.readFile(absolute, 'utf8')
    if (text.includes('\0')) return changed
    const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
    return { ...changed, diff: `@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join('\n')}`, added: lines.length }
  } catch {
    return changed
  }
}

const GIT_NOT_REVIEWED = { state: 'skipped', reason: 'Git changes are not reviewed: Rearview reviews the turns Claude takes. The Code and Map tabs still show them.' }

/** Uncommitted changes against HEAD, untracked files included, shaped like a turn so the same views draw them. */
async function loadWorkingTree(root) {
  const diff = await runGit(root, ['diff', 'HEAD', '-M', '--no-color', '--no-ext-diff'])
  const files = diff.code === 0 ? parseGitPatch(diff.stdout) : []
  const untracked = await runGit(root, ['ls-files', '--others', '--exclude-standard'])
  for (const file of untracked.stdout.split('\n').filter(Boolean).slice(0, MAX_UNTRACKED)) files.push(await untrackedFile(root, file))
  return { id: 'git:worktree', isGit: true, request: 'Uncommitted changes', answer: '', finishedAt: Date.now(), files, affected: [], filesRead: [], review: GIT_NOT_REVIEWED }
}

/** Recent commits as turns whose files load when first shown (a commit never changes, so once is enough). */
async function loadCommits(root) {
  const log = await runGit(root, ['log', `-n${MAX_COMMITS}`, '--format=%H%x1f%h%x1f%ct%x1f%s%x1f%b%x1e'])
  if (log.code !== 0) return []
  return log.stdout
    .split('\x1e')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      const [sha, short, time, subject, body] = entry.split('\x1f')
      return { id: `git:${sha}`, isGit: true, sha, short, request: body && body.trim() ? `${subject}\n\n${body.trim()}` : subject, answer: '', finishedAt: Number(time) * 1000, files: null, affected: [], filesRead: [], review: GIT_NOT_REVIEWED }
    })
}

async function loadCommitFiles(root, sha) {
  const show = await runGit(root, ['show', '--format=', '-M', '--no-color', '--no-ext-diff', sha])
  return show.code === 0 ? parseGitPatch(show.stdout) : []
}

/** Opens the system folder picker where Obsidian allows it; undefined when it cannot. */
function pickFolder() {
  try {
    const electron = require('electron')
    const remote = electron.remote || require('@electron/remote')
    const picked = remote.dialog.showOpenDialogSync({ properties: ['openDirectory'] })
    return picked && picked[0] ? picked[0] : null
  } catch {
    return undefined
  }
}

// ---------- the Map: which files use which (the same import rules as hooks/trace.ts) ----------

/** The Map adds at most this many unchanged files that the changed files import. */
const MAX_MAP_EXTRA = 8
/** Files larger than this are not read for imports. */
const MAX_MAP_FILE_BYTES = 500000
const IMPORT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '/index.ts', '/index.tsx', '/index.js']

/** The module paths a file names: JS/TS `import … from`, `require()`, and Python `from x import`. */
function parseImports(source) {
  const specs = []
  const patterns = [/\bfrom\s+['"]([^'"]+)['"]/g, /\bimport\s+['"]([^'"]+)['"]/g, /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, /^\s*from\s+(\.+\w[\w.]*)\s+import\b/gm]
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) specs.push(match[1])
  for (const match of source.matchAll(/^\s*from\s+(\.+)\s+import\s+(\w+)/gm)) specs.push(match[1] + match[2])
  return specs
}

function withoutExtension(file) {
  return file.replace(/\.(tsx?|jsx?|mjs|cjs|py)$/, '').replace(/\/index$/, '')
}

/** `src/settings/Panel.tsx` + `../theme/Theme` -> `src/theme/Theme`; package imports give null. */
function resolveImport(fromFile, spec) {
  const isPython = /^\.+[\w.]*$/.test(spec) && !spec.includes('/')
  let relative = spec
  if (isPython) {
    const dots = spec.match(/^\.+/)[0].length
    relative = (dots === 1 ? './' : '../'.repeat(dots - 1)) + spec.slice(dots).replace(/\./g, '/')
  }
  if (!relative.startsWith('.')) return null
  const parts = fromFile.split('/').slice(0, -1)
  for (const part of relative.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return withoutExtension(parts.join('/'))
}

/** A project file's text for import reading: '' for secrets, large or missing files. */
async function readForImports(root, file) {
  if (SECRET_FILE.test(file)) return ''
  try {
    const absolute = path.join(root, file)
    if ((await fs.promises.stat(absolute)).size > MAX_MAP_FILE_BYTES) return ''
    return await fs.promises.readFile(absolute, 'utf8')
  } catch {
    return ''
  }
}

async function fileForStem(root, stem) {
  for (const extension of IMPORT_EXTENSIONS) {
    try {
      if ((await fs.promises.stat(path.join(root, stem + extension))).isFile()) return stem + extension
    } catch {
      // Not this extension; try the next.
    }
  }
  return null
}

/**
 * The files around a turn's changes and which uses which, read from the files as they are now:
 * the changed files, the files that import them (affected), and unchanged files the changed ones import.
 */
async function buildMap(root, turn) {
  const nodes = new Map()
  for (const file of turn.files) {
    const kind = file.change === 'new' ? 'new' : file.change === 'deleted' ? 'deleted' : 'edited'
    nodes.set(file.path, { path: file.path, kind })
  }
  for (const file of turn.affected || []) if (!nodes.has(file)) nodes.set(file, { path: file, kind: 'affected' })

  const imports = new Map()
  for (const file of nodes.keys()) {
    const stems = parseImports(await readForImports(root, file)).map(spec => resolveImport(file, spec))
    imports.set(file, [...new Set(stems.filter(Boolean))])
  }
  const byStem = new Map([...nodes.keys()].map(file => [withoutExtension(file), file]))
  let extra = 0
  for (const file of turn.files) {
    for (const stem of imports.get(file.path) || []) {
      if (byStem.has(stem) || extra >= MAX_MAP_EXTRA) continue
      const found = await fileForStem(root, stem)
      if (!found || nodes.has(found)) continue
      nodes.set(found, { path: found, kind: 'untouched' })
      byStem.set(stem, found)
      extra++
    }
  }
  const edges = []
  for (const [from, stems] of imports) {
    for (const stem of stems) {
      const to = byStem.get(stem)
      if (to && to !== from) edges.push({ from, to })
    }
  }
  return { nodes: [...nodes.values()], edges }
}

function definitionPattern(symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b(function|class|interface|type|enum|const|let|var|def|fn|func|struct)\\s+${escaped}\\b`)
}

// ---------- the plugin ----------

class RearviewPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
    /** root -> { root, turns, error } */
    this.projects = new Map()
    /** The turn shown, as { root, turnId }; null shows the newest. */
    this.selected = null
    this.tab = 'code'
    this.trace = null
    this.draft = ''
    this.watched = []
    /** turn id -> its Map, built once since it reads files */
    this.mapCache = new Map()
    this.gitTimers = []
    /** Projects whose Git status is being read right now. */
    this.gitBusy = new Set()
    /** commit sha -> its changed files */
    this.commitFiles = new Map()

    this.registerView(TURNS_VIEW, leaf => new TurnsView(leaf, this))
    this.registerView(TURN_VIEW, leaf => new TurnView(leaf, this))
    this.registerView(SIDE_VIEW, leaf => new SideView(leaf, this))
    this.addRibbonIcon('eye', 'Open Rearview', () => this.openAll())
    this.addCommand({ id: 'open', name: 'Open Rearview', callback: () => this.openAll() })
    this.addCommand({ id: 'open-latest-turn', name: 'Open the latest turn', callback: () => this.openLatest() })
    this.addCommand({ id: 'add-project', name: 'Add a project folder', callback: () => new ProjectModal(this.app, this, null).open() })
    this.statusEl = this.addStatusBarItem()
    this.addSettingTab(new RearviewSettingTab(this.app, this))
    this.app.workspace.onLayoutReady(() => this.watchProjects())
  }

  onunload() {
    this.unwatch()
  }

  async saveSettings() {
    await this.saveData(this.settings)
    this.watchProjects()
  }

  watchProjects() {
    this.unwatch()
    this.projects.clear()
    for (const root of this.settings.projects) {
      const file = path.join(root, DATA_DIR, 'turns.json')
      const listener = () => this.loadProject(root, true)
      fs.watchFile(file, { interval: WATCH_MS }, listener)
      this.watched.push({ file, listener })
      this.projects.set(root, { root, turns: [], error: 'Loading…', git: null })
      this.loadProject(root, false)
      this.pollGit(root)
      this.gitTimers.push(window.setInterval(() => this.pollGit(root), GIT_POLL_MS))
    }
    this.refresh()
  }

  unwatch() {
    for (const { file, listener } of this.watched) fs.unwatchFile(file, listener)
    this.watched = []
    for (const timer of this.gitTimers) window.clearInterval(timer)
    this.gitTimers = []
  }

  /** Re-reads a project's Git changes when `git status` or HEAD has moved since the last look. */
  async pollGit(root) {
    if (this.gitBusy.has(root) || !this.projects.has(root)) return
    this.gitBusy.add(root)
    // loadProject replaces a project's object, so results go to whichever object is current when they arrive.
    const setGit = git => {
      const project = this.projects.get(root)
      if (project) project.git = git
    }
    try {
      const head = await runGit(root, ['rev-parse', 'HEAD'])
      if (head.code !== 0 && head.code !== 128) return
      const isRepo = (await runGit(root, ['rev-parse', '--is-inside-work-tree'])).code === 0
      if (!isRepo) {
        setGit({ isRepo: false })
        return this.refresh([TURNS_VIEW])
      }
      const status = await runGit(root, ['status', '--porcelain=v1'])
      // `git status` reads the same for a second edit to a changed file, so each changed file's mtime counts too.
      const stamps = await Promise.all(
        status.stdout
          .split('\n')
          .filter(Boolean)
          .map(line => line.slice(3).split(' -> ').pop())
          .map(file => fs.promises.stat(path.join(root, file)).then(s => s.mtimeMs, () => 0)),
      )
      const signature = `${head.stdout}|${status.stdout}|${stamps.join(',')}`
      const before = this.projects.get(root).git
      if (before && before.signature === signature) return
      const branch = (await runGit(root, ['branch', '--show-current'])).stdout.trim() || 'detached HEAD'
      const commits = before && before.head === head.stdout ? before.commits : await loadCommits(root)
      for (const commit of commits) if (this.commitFiles.has(commit.sha)) commit.files = this.commitFiles.get(commit.sha)
      setGit({ isRepo: true, signature, head: head.stdout, branch, worktree: await loadWorkingTree(root), commits })
      this.mapCache.delete('git:worktree')
      const shown = this.current()
      this.refresh(shown && shown.turn.isGit ? undefined : [TURNS_VIEW])
    } finally {
      this.gitBusy.delete(root)
    }
  }

  /** Loads a commit's files the first time it is shown. */
  async ensureCommitFiles(root, commit) {
    if (commit.files || commit.loading) return
    commit.loading = true
    commit.files = await loadCommitFiles(root, commit.sha)
    this.commitFiles.set(commit.sha, commit.files)
    commit.loading = false
    this.refresh([TURN_VIEW, SIDE_VIEW])
  }

  async addProject(root) {
    if (!this.settings.projects.includes(root)) this.settings.projects.push(root)
    await this.saveSettings()
    new Notice(`Rearview: following ${path.basename(root)}.`)
    await this.openAll()
  }

  async loadProject(root, isUpdate) {
    const before = this.projects.get(root)
    let project
    try {
      const data = JSON.parse(await fs.promises.readFile(path.join(root, DATA_DIR, 'turns.json'), 'utf8'))
      project = { ...before, root, turns: Array.isArray(data.turns) ? data.turns : [], error: null }
    } catch (error) {
      const reason = error.code === 'ENOENT' ? 'No Claude Code turns yet. Rearview writes them when a session starts in this project.' : `Could not read turns.json: ${error.message}`
      project = { ...before, root, turns: [], error: reason }
    }
    this.projects.set(root, project)
    const latest = project.turns[project.turns.length - 1]
    const isNewTurn = isUpdate && latest && !(before && before.turns.some(t => t.id === latest.id))
    if (isNewTurn) {
      this.selected = { root, turnId: latest.id }
      this.trace = null
      if (this.settings.openOnNewTurn) await this.openAll()
    }
    this.refresh()
  }

  /**
   * What is on show: the selected turn or Git change, else the newest turn across projects,
   * else a project's uncommitted changes. `label` names it ("Turn 4", "Commit a1b2c3d").
   */
  current() {
    const find = (project, id) => {
      const index = project.turns.findIndex(t => t.id === id)
      if (index >= 0) return { project, turn: project.turns[index], label: `Turn ${index + 1}` }
      const git = project.git
      if (!git || !git.isRepo) return null
      if (git.worktree && git.worktree.id === id) return { project, turn: git.worktree, label: 'Uncommitted changes' }
      const commit = git.commits.find(c => c.id === id)
      return commit ? { project, turn: commit, label: `Commit ${commit.short}` } : null
    }
    if (this.selected) {
      const project = this.projects.get(this.selected.root)
      const found = project && find(project, this.selected.turnId)
      if (found) return found
    }
    let best = null
    for (const project of this.projects.values()) {
      const last = project.turns[project.turns.length - 1]
      if (last && (!best || last.finishedAt > best.turn.finishedAt)) best = find(project, last.id)
    }
    if (best) return best
    for (const project of this.projects.values()) {
      if (project.git && project.git.isRepo && project.git.worktree) return find(project, project.git.worktree.id)
    }
    return null
  }

  select(root, turnId) {
    this.selected = { root, turnId }
    this.trace = null
    this.refresh()
    this.openTurnView()
  }

  openLatest() {
    this.selected = null
    this.trace = null
    this.refresh()
    this.openAll()
  }

  /** Redraws the open views of the given types (all by default). */
  refresh(types = [TURNS_VIEW, TURN_VIEW, SIDE_VIEW]) {
    for (const type of types) {
      // A leaf Obsidian has not loaded yet holds a placeholder view with nothing to draw.
      for (const leaf of this.app.workspace.getLeavesOfType(type)) if (typeof leaf.view.render === 'function') leaf.view.render()
    }
    const shown = this.current()
    this.statusEl.setText(shown ? `Rearview · ${shown.label} · ${score(shown.turn).label}` : 'Rearview · nothing to show yet')
  }

  async openAll() {
    await this.ensureLeaf(TURNS_VIEW, () => this.app.workspace.getLeftLeaf(false))
    await this.ensureLeaf(SIDE_VIEW, () => this.app.workspace.getRightLeaf(false))
    await this.openTurnView()
  }

  async openTurnView() {
    return this.ensureLeaf(TURN_VIEW, () => this.app.workspace.getLeaf('tab'))
  }

  async ensureLeaf(type, makeLeaf) {
    let leaf = this.app.workspace.getLeavesOfType(type)[0]
    if (!leaf) {
      leaf = makeLeaf()
      await leaf.setViewState({ type, active: true })
    }
    this.app.workspace.revealLeaf(leaf)
    return leaf
  }

  async scrollToFile(file) {
    this.tab = 'code'
    const leaf = await this.openTurnView()
    leaf.view.render()
    const section = [...leaf.view.contentEl.querySelectorAll('.rv-file')].find(el => el.dataset.path === file)
    if (section) section.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  runTrace(root, symbol) {
    if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) return
    this.trace = { root, symbol, state: 'running', definitions: [], uses: [] }
    this.refresh([SIDE_VIEW])
    this.ensureLeaf(SIDE_VIEW, () => this.app.workspace.getRightLeaf(false))
    const argv = ['grep', '--untracked', '-n', '-w', '-I', '-F', '--', symbol]
    execFile('git', argv, { cwd: root, maxBuffer: 4 * 1024 * 1024, timeout: 15000 }, (error, stdout) => {
      if (!this.trace || this.trace.symbol !== symbol) return
      // Exit code 1 is git grep's "no matches", an empty answer rather than an error.
      if (error && error.code !== 1) {
        this.trace = { root, symbol, state: 'failed', definitions: [], uses: [] }
      } else {
        const hits = String(stdout)
          .split('\n')
          .map(parseGrepLine)
          .filter(hit => hit !== null && !SECRET_FILE.test(hit.file))
          .slice(0, MAX_TRACE_HITS)
        const isDefinition = definitionPattern(symbol)
        this.trace = {
          root,
          symbol,
          state: 'done',
          definitions: hits.filter(hit => isDefinition.test(hit.text)),
          uses: hits.filter(hit => !isDefinition.test(hit.text)),
        }
      }
      this.refresh([SIDE_VIEW])
    })
  }

  openProjectFile(root, file) {
    require('electron').shell.openPath(path.join(root, file))
  }

  /** Queues a steer for the Claude Code session running in `root`; true when it was queued. */
  async sendSteer(root, text, remember) {
    const steer = text.trim()
    if (steer === '') {
      new Notice('Write what Claude should do instead first.')
      return false
    }
    let code = null
    try {
      code = JSON.parse(await fs.promises.readFile(path.join(root, DATA_DIR, 'session.json'), 'utf8')).code
    } catch {
      // No session file: Rearview has not run in this project yet.
    }
    if (typeof code !== 'string') {
      new Notice('Rearview: start a Claude Code session in this project first.')
      return false
    }
    await fs.promises.appendFile(path.join(root, DATA_DIR, 'inbox.jsonl'), `${JSON.stringify({ code, text: steer, remember })}\n`)
    new Notice('Sent. It reaches Claude Code within a few seconds, if a session is open in this project.')
    return true
  }
}

// ---------- drawing helpers ----------

function chip(parent, text, tone) {
  return parent.createEl('span', { cls: `rv-chip rv-${tone}`, text })
}

function counts(parent, added, removed) {
  const el = parent.createEl('span', { cls: 'rv-mono rv-counts' })
  el.createEl('span', { cls: 'rv-add-text', text: `+${added}` })
  el.createEl('span', { cls: 'rv-del-text', text: ` −${removed}` })
  return el
}

function emptyState(el, plugin) {
  const box = el.createDiv({ cls: 'rv-empty' })
  box.createEl('h3', { text: 'Add a project' })
  box.createEl('p', {
    text: 'Pick a project folder in a Git repository. Rearview checks the connection, then shows its changes and the turns Claude Code takes there.',
  })
  const button = box.createEl('button', { cls: 'mod-cta', text: 'Add project folder' })
  button.addEventListener('click', () => new ProjectModal(plugin.app, plugin, null).open())
}

function sectionTitle(parent, text) {
  return parent.createEl('div', { cls: 'rv-h', text })
}

// ---------- left sidebar: turns ----------

class TurnsView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf)
    this.plugin = plugin
  }
  getViewType() {
    return TURNS_VIEW
  }
  getDisplayText() {
    return 'Rearview turns'
  }
  getIcon() {
    return 'eye'
  }
  async onOpen() {
    this.render()
  }

  render() {
    const el = this.contentEl
    el.empty()
    el.addClass('rv')
    const top = el.createDiv({ cls: 'rv-card-hd' })
    sectionTitle(top, 'Rearview · projects')
    const add = top.createEl('button', { cls: 'rv-link rv-push', text: '+ Add project folder' })
    add.addEventListener('click', () => new ProjectModal(this.app, this.plugin, null).open())
    if (this.plugin.settings.projects.length === 0) return emptyState(el, this.plugin)
    const shown = this.plugin.current()
    const row = (parent, project, turn, id, title) => {
      const isShown = shown && shown.turn.id === turn.id && shown.project.root === project.root
      const button = parent.createEl('button', { cls: `rv-row${isShown ? ' is-active' : ''}` })
      button.createEl('span', { cls: 'rv-id', text: id })
      button.createEl('span', { cls: 'rv-row-title', text: title })
      const s = score(turn)
      chip(button, s.label, s.tone)
      button.addEventListener('click', () => this.plugin.select(project.root, turn.id))
    }
    for (const project of this.plugin.projects.values()) {
      const group = el.createDiv({ cls: 'rv-group' })
      const head = group.createDiv({ cls: 'rv-group-head' })
      head.createEl('span', { cls: 'rv-group-name', text: path.basename(project.root) })
      const git = project.git
      if (git && git.isRepo) chip(head, git.branch, 'blue')
      else if (git) chip(head, 'not a Git repository', 'red')
      const check = head.createEl('button', { cls: 'rv-link rv-push', text: 'Check connection' })
      check.addEventListener('click', () => new ProjectModal(this.app, this.plugin, project.root).open())

      group.createDiv({ cls: 'rv-subhead', text: 'Claude Code turns' })
      if (project.turns.length === 0) group.createDiv({ cls: 'rv-muted rv-pad', text: project.error || 'No turns yet.' })
      for (let i = project.turns.length - 1; i >= 0; i--) row(group, project, project.turns[i], `T${i + 1}`, titleOf(project.turns[i].request))

      if (!git || !git.isRepo) continue
      group.createDiv({ cls: 'rv-subhead', text: 'Git' })
      if (git.worktree.files.length) row(group, project, git.worktree, 'now', 'Uncommitted changes')
      else group.createDiv({ cls: 'rv-muted rv-pad', text: 'No uncommitted changes.' })
      for (const commit of git.commits) row(group, project, commit, commit.short, titleOf(commit.request))
    }
  }
}

// ---------- adding a project, and checking its Git connection ----------

/** Adds a project folder (folder null) or re-checks one, showing each step of the Git connection check. */
class ProjectModal extends Modal {
  constructor(app, plugin, folder) {
    super(app)
    this.plugin = plugin
    this.folder = folder
  }

  onOpen() {
    const el = this.contentEl
    el.addClass('rv')
    this.titleEl.setText(this.folder ? 'Git connection' : 'Add a project folder')
    if (this.folder) return this.check(this.folder)
    el.createEl('p', { cls: 'rv-muted', text: 'Pick a project folder. Rearview checks that it can follow it through Git, then shows its uncommitted changes, its recent commits, and the turns Claude Code takes there.' })
    const line = el.createDiv({ cls: 'rv-path-row' })
    const input = line.createEl('input', { attr: { type: 'text', placeholder: '/Users/you/code/my-app', 'aria-label': 'Project folder' } })
    const browse = line.createEl('button', { text: 'Browse…' })
    browse.addEventListener('click', () => {
      const picked = pickFolder()
      if (picked === undefined) new Notice('The folder picker is not available here. Type or paste the path instead.')
      else if (picked) input.value = picked
    })
    const go = el.createEl('button', { cls: 'mod-cta', text: 'Check connection' })
    this.results = el.createDiv({ cls: 'rv-steps' })
    go.addEventListener('click', () => {
      const folder = input.value.trim().replace(/^~(?=\/)/, require('os').homedir())
      if (folder === '') return new Notice('Choose a folder first.')
      this.check(folder)
    })
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') go.click()
    })
  }

  async check(folder) {
    if (!this.results) this.results = this.contentEl.createDiv({ cls: 'rv-steps' })
    const box = this.results
    box.empty()
    box.createDiv({ cls: 'rv-muted', text: 'Checking…' })
    const result = await checkGitConnection(folder)
    box.empty()
    const marks = { ok: '✓', warn: '!', fail: '✗' }
    const tones = { ok: 'green', warn: 'orange', fail: 'red' }
    for (const step of result.steps) {
      const line = box.createDiv({ cls: 'rv-step' })
      line.createEl('span', { cls: `rv-chip rv-${tones[step.status]}`, text: marks[step.status] })
      line.createEl('span', { cls: 'rv-strong', text: step.label })
      line.createEl('span', { cls: 'rv-muted rv-step-detail', text: step.detail })
    }
    if (!result.isOk) return box.createDiv({ cls: 'rv-callout rv-red', text: 'This folder cannot be followed through Git yet. Fix the step marked ✗ and check again.' })
    if (this.folder) return box.createDiv({ cls: 'rv-callout rv-green', text: 'Connected. Rearview is following this project.' })
    const add = box.createEl('button', { cls: 'mod-cta', text: `Add ${path.basename(result.root)}` })
    add.addEventListener('click', async () => {
      await this.plugin.addProject(result.root)
      this.close()
    })
  }

  onClose() {
    this.contentEl.empty()
  }
}

// ---------- main tab: one turn ----------

class TurnView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf)
    this.plugin = plugin
    this.shownKey = null
  }
  getViewType() {
    return TURN_VIEW
  }
  getDisplayText() {
    const shown = this.plugin.current()
    return shown ? `${shown.label} · ${titleOf(shown.turn.request)}` : 'Rearview'
  }
  getIcon() {
    return 'eye'
  }
  async onOpen() {
    this.render()
  }

  render() {
    const el = this.contentEl
    const shown = this.plugin.current()
    const key = shown ? `${shown.turn.id}:${this.plugin.tab}` : null
    // A redraw of the same turn and tab keeps the reader's place.
    const scrollTop = key === this.shownKey ? el.scrollTop : 0
    this.shownKey = key
    el.empty()
    el.addClass('rv', 'rv-turn')
    if (!shown) {
      if (this.plugin.settings.projects.length === 0) emptyState(el, this.plugin)
      else el.createDiv({ cls: 'rv-empty', text: 'No turns yet. Finish a turn in Claude Code and it appears here.' })
      return
    }
    const { project, turn, label } = shown
    if (turn.files === null) {
      // A commit's files load the first time it is shown.
      el.createDiv({ cls: 'rv-muted rv-pad', text: `Loading ${label}…` })
      this.plugin.ensureCommitFiles(project.root, turn)
      return
    }
    const review = turn.review || {}
    const result = review.state === 'done' ? review.result : null

    const head = el.createDiv({ cls: 'rv-head' })
    head.createEl('span', { cls: 'rv-crumb', text: `${path.basename(project.root)} / ${label}` })
    head.createEl('span', { cls: 'rv-muted', text: new Date(turn.finishedAt).toLocaleString() })

    const card = el.createDiv({ cls: 'rv-card' })
    const cardHead = card.createDiv({ cls: 'rv-card-hd' })
    sectionTitle(cardHead, turn.isGit ? (turn.sha ? 'Commit message' : 'Working tree') : 'Your request')
    const s = score(turn)
    chip(cardHead, s.label, s.tone)
    card.createEl('p', { cls: 'rv-request', text: turn.request })
    if (result) {
      const chips = card.createDiv({ cls: 'rv-chips' })
      for (const r of result.requirements) chip(chips, `${r.id} ${r.text} · ${r.status}`, STATUS_TONES[r.status] || 'muted')
      const extras = result.steps.filter(step => step.kind === 'unrequested').length
      if (extras) chip(chips, `${extras} not requested`, 'purple')
      if (result.violations.length) chip(chips, `${result.violations.length} against a principle`, 'red')
    } else {
      const reason = review.state === 'pending' ? 'Reviewing this turn…' : review.reason || 'Not reviewed.'
      card.createDiv({ cls: 'rv-muted', text: reason })
    }

    const tabs = el.createDiv({ cls: 'rv-tabs', attr: { role: 'tablist' } })
    for (const [id, label] of [['code', 'Code'], ['map', 'Map'], ['check', 'Check work'], ['reasoning', 'Reasoning']]) {
      const isOn = this.plugin.tab === id
      const button = tabs.createEl('button', { cls: `rv-tab${isOn ? ' is-active' : ''}`, text: label, attr: { role: 'tab', 'aria-selected': String(isOn) } })
      button.addEventListener('click', () => {
        this.plugin.tab = id
        this.render()
      })
    }
    const total = tabs.createEl('span', { cls: 'rv-push rv-muted' })
    total.createEl('span', { text: `${turn.files.length} files · ` })
    counts(total, turn.files.reduce((n, f) => n + f.added, 0), turn.files.reduce((n, f) => n + f.removed, 0))

    if (this.plugin.tab === 'map') renderMap(el, turn, project, this)
    else if (this.plugin.tab === 'check') renderCheck(el, turn, review, result, project, this.plugin)
    else if (this.plugin.tab === 'reasoning') renderReasoning(el, review, result, project, this.plugin)
    else renderCode(el, turn, result, project, this.plugin)
    el.scrollTop = scrollTop
    // The tab and header titles come from getDisplayText, which Obsidian reads again only when asked.
    if (typeof this.leaf.updateHeader === 'function') this.leaf.updateHeader()
  }
}

function renderCode(el, turn, result, project, plugin) {
  el.createEl('h1', { cls: 'rv-title', text: 'What Claude changed, and why' })
  el.createEl('p', { cls: 'rv-sub', text: 'Every changed line that needed a reason has one, tied back to the part of your request it serves.' })
  if (turn.files.length === 0) {
    el.createDiv({ cls: 'rv-muted', text: 'Nothing was changed in this turn.' })
    return
  }
  const notes = result ? result.notes : []
  for (const file of turn.files) {
    const section = el.createDiv({ cls: 'rv-file' })
    section.dataset.path = file.path
    const fileHead = section.createDiv({ cls: 'rv-file-hd' })
    fileHead.createEl('span', { cls: 'rv-mono rv-strong', text: file.path })
    const [label, tone] = CHANGE_LABELS[file.change] || ['Changed', 'muted']
    chip(fileHead, label, tone)
    const serves = result ? result.requirements.filter(r => r.evidence.some(e => e.file === file.path)) : []
    for (const r of serves) chip(fileHead, r.id, 'muted')
    counts(fileHead, file.added, file.removed).addClass('rv-push')

    const gaps = result ? result.requirements.filter(r => r.status !== 'done' && r.evidence.some(e => e.file === file.path)) : []
    const extras = result ? result.steps.filter(step => step.kind === 'unrequested' && step.evidence.some(e => e.file === file.path)) : []
    if (gaps.length || extras.length) {
      const band = section.createDiv({ cls: 'rv-band' })
      for (const r of gaps) band.createDiv({ cls: 'rv-callout rv-orange', text: `${r.id} is ${r.status}: ${r.finding}` })
      for (const step of extras) band.createDiv({ cls: 'rv-callout rv-purple', text: `Not requested: ${step.title}. ${step.why}` })
    }

    if (file.isSecret) {
      section.createDiv({ cls: 'rv-muted rv-pad', text: 'Contents hidden: this looks like a secrets file, so Rearview never reads it.' })
      continue
    }
    if (!file.diff) {
      section.createDiv({ cls: 'rv-muted rv-pad', text: 'No line changes to show (a binary, large, renamed or empty file).' })
      continue
    }
    const fileNotes = notes.filter(n => n.file === file.path)
    const placed = new Set()
    const code = section.createDiv({ cls: 'rv-code' })
    const rows = parseDiff(file.diff || '')
    for (const row of rows.slice(0, MAX_DIFF_LINES)) {
      if (row.kind === 'hunk') {
        code.createDiv({ cls: 'rv-hunk', text: row.text })
        continue
      }
      const line = code.createDiv({ cls: `rv-ln rv-ln-${row.kind}` })
      line.createEl('span', { cls: 'rv-no', text: row.kind === 'del' ? '' : String(row.newNo) })
      line.createEl('span', { cls: 'rv-sign', text: row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : '' })
      line.createEl('span', { cls: 'rv-tx', text: row.text })
      if (row.kind === 'del') continue
      for (const note of fileNotes) {
        if (note.line === row.newNo) {
          renderWhy(code, note, project, plugin)
          placed.add(note)
        }
      }
    }
    if (rows.length > MAX_DIFF_LINES) code.createDiv({ cls: 'rv-more', text: `${rows.length - MAX_DIFF_LINES} more lines not shown` })
    const unplaced = fileNotes.filter(n => !placed.has(n))
    for (const note of unplaced) renderWhy(code, note, project, plugin, `Line ${note.line}`)
  }
}

const MAP_KINDS = {
  edited: 'Edited',
  new: 'New',
  deleted: 'Deleted',
  affected: 'Affected, not edited',
  untouched: 'Untouched',
}
const NODE_W = 210
const NODE_H = 46
const ROW_GAP = 16
const COL_GAP = 96
const MAP_TOP = 34

function svg(parent, tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value))
  parent.appendChild(el)
  return el
}

/** The Map tab. The map is built once per turn (it reads files), then redrawn from the plugin's cache. */
function renderMap(el, turn, project, view) {
  const plugin = view.plugin
  el.createEl('h1', { cls: 'rv-title', text: 'How the pieces connect' })
  el.createEl('p', { cls: 'rv-sub', text: 'Boxes are files. Lines mean one file uses another. Click a changed file to see its change and why; click any other to open it.' })
  const legend = el.createDiv({ cls: 'rv-legend' })
  for (const [kind, label] of Object.entries(MAP_KINDS)) {
    const item = legend.createEl('span', { cls: 'rv-legend-item' })
    item.createEl('span', { cls: `rv-swatch rv-node-${kind}` })
    item.createEl('span', { text: label })
  }
  if (turn.files.length === 0) {
    el.createDiv({ cls: 'rv-muted', text: 'Nothing was changed in this turn, so there is nothing to map.' })
    return
  }
  const map = plugin.mapCache.get(turn.id)
  if (!map) {
    el.createDiv({ cls: 'rv-muted', text: 'Building the map…' })
    buildMap(project.root, turn).then(built => {
      plugin.mapCache.set(turn.id, built)
      const shown = plugin.current()
      if (plugin.tab === 'map' && shown && shown.turn.id === turn.id) view.render()
    })
    return
  }
  drawMap(el.createDiv({ cls: 'rv-map' }), map, project, plugin)

  const list = el.createDiv({ cls: 'rv-card' })
  sectionTitle(list, 'Connections')
  if (map.edges.length === 0) list.createDiv({ cls: 'rv-muted', text: 'None of these files import each other.' })
  for (const edge of map.edges) {
    const row = list.createDiv({ cls: 'rv-edge-row' })
    row.createEl('span', { cls: 'rv-mono', text: edge.from })
    row.createEl('span', { cls: 'rv-muted', text: 'uses' })
    row.createEl('span', { cls: 'rv-mono', text: edge.to })
  }
}

function drawMap(container, map, project, plugin) {
  const columns = [
    { label: 'Uses the changes', nodes: map.nodes.filter(n => n.kind === 'affected') },
    { label: 'Changed', nodes: map.nodes.filter(n => n.kind === 'edited' || n.kind === 'new' || n.kind === 'deleted') },
    { label: 'Used by the changes', nodes: map.nodes.filter(n => n.kind === 'untouched') },
  ].filter(column => column.nodes.length > 0)
  const rows = Math.max(...columns.map(column => column.nodes.length))
  const width = columns.length * NODE_W + (columns.length - 1) * COL_GAP + 60
  const height = MAP_TOP + rows * (NODE_H + ROW_GAP) + 10
  const root = svg(container, 'svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Map of the files around this change' })
  const defs = svg(root, 'defs')
  const marker = svg(defs, 'marker', { id: 'rv-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' })
  svg(marker, 'path', { d: 'M0,0 L10,5 L0,10 z', class: 'rv-arrowhead' })

  const place = new Map()
  columns.forEach((column, c) => {
    const x = 30 + c * (NODE_W + COL_GAP)
    const label = svg(root, 'text', { x, y: 16, class: 'rv-col-label' })
    label.textContent = column.label
    column.nodes.forEach((node, r) => place.set(node.path, { x, y: MAP_TOP + r * (NODE_H + ROW_GAP), column: c }))
  })

  // Lines first, so the boxes sit on top of them.
  for (const edge of map.edges) {
    const a = place.get(edge.from)
    const b = place.get(edge.to)
    if (!a || !b) continue
    let d
    if (a.column === b.column) {
      // Two files in one column: a loop out to the right.
      const x = a.x + NODE_W
      d = `M${x},${a.y + NODE_H / 2} C${x + 40},${a.y + NODE_H / 2} ${x + 40},${b.y + NODE_H / 2} ${x},${b.y + NODE_H / 2}`
    } else {
      const forward = a.x < b.x
      const x1 = forward ? a.x + NODE_W : a.x
      const x2 = forward ? b.x : b.x + NODE_W
      const bend = (x2 - x1) / 2
      d = `M${x1},${a.y + NODE_H / 2} C${x1 + bend},${a.y + NODE_H / 2} ${x2 - bend},${b.y + NODE_H / 2} ${x2},${b.y + NODE_H / 2}`
    }
    svg(root, 'path', { d, class: 'rv-edge', 'marker-end': 'url(#rv-arrow)' })
  }

  for (const node of map.nodes) {
    const at = place.get(node.path)
    if (!at) continue
    const group = svg(root, 'g', { class: `rv-node rv-node-${node.kind}`, tabindex: 0, role: 'button', 'aria-label': `${node.path}, ${MAP_KINDS[node.kind]}` })
    svg(group, 'rect', { x: at.x, y: at.y, width: NODE_W, height: NODE_H, rx: 8 })
    const name = svg(group, 'text', { x: at.x + 12, y: at.y + 19, class: 'rv-node-name' })
    name.textContent = shorten(path.basename(node.path), 26)
    const folder = svg(group, 'text', { x: at.x + 12, y: at.y + 36, class: 'rv-node-dir' })
    folder.textContent = shorten(path.dirname(node.path) === '.' ? '(project root)' : path.dirname(node.path), 30)
    const title = svg(group, 'title')
    title.textContent = `${node.path} · ${MAP_KINDS[node.kind]}`
    const open = () => (node.kind === 'affected' || node.kind === 'untouched' ? plugin.openProjectFile(project.root, node.path) : plugin.scrollToFile(node.path))
    group.addEventListener('click', open)
    group.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') open()
    })
  }
}

function shorten(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function renderWhy(parent, note, project, plugin, prefix) {
  const why = parent.createDiv({ cls: 'rv-why' })
  why.createEl('span', { cls: 'rv-why-label', text: prefix ? `Why · ${prefix}` : 'Why' })
  why.createEl('span', { cls: 'rv-why-text', text: note.why })
  const source = SOURCES[note.source] || SOURCES.none
  chip(why, source.label, source.tone)
  for (const symbol of note.symbols || []) {
    const button = why.createEl('button', { cls: 'rv-link', text: `Trace ${symbol} ›` })
    button.addEventListener('click', () => plugin.runTrace(project.root, symbol))
  }
}

function renderEvidence(parent, evidence, project, plugin) {
  if (!evidence || evidence.length === 0) return
  const list = parent.createDiv({ cls: 'rv-evidence' })
  for (const e of evidence) {
    const button = list.createEl('button', { cls: 'rv-link rv-mono', text: e.line ? `${e.file}:${e.line}` : e.file })
    button.addEventListener('click', () => plugin.openProjectFile(project.root, e.file))
  }
}

function notReviewed(el, review) {
  el.createDiv({ cls: 'rv-muted rv-pad', text: review.state === 'pending' ? 'Reviewing this turn…' : review.reason || 'This turn was not reviewed.' })
}

function renderCheck(el, turn, review, result, project, plugin) {
  el.createEl('h1', { cls: 'rv-title', text: 'Did Claude do what you asked?' })
  if (!result) return notReviewed(el, review)
  const done = result.requirements.filter(r => r.status === 'done').length
  el.createEl('p', { cls: 'rv-sub', text: `${done} of ${result.requirements.length} parts done. The reviewer compared each part of your request with the actual changes.` })
  for (const r of result.requirements) {
    const card = el.createDiv({ cls: 'rv-card' })
    const head = card.createDiv({ cls: 'rv-card-hd' })
    head.createEl('span', { cls: 'rv-id', text: r.id })
    head.createEl('span', { cls: 'rv-strong rv-grow', text: r.text })
    chip(head, r.status, STATUS_TONES[r.status] || 'muted')
    if (r.finding) card.createEl('p', { text: r.finding })
    renderEvidence(card, r.evidence, project, plugin)
  }
  for (const v of result.violations) {
    el.createDiv({ cls: 'rv-callout rv-red', text: `Goes against your principle "${v.principleId}": ${v.finding}` })
  }
}

function renderReasoning(el, review, result, project, plugin) {
  el.createEl('h1', { cls: 'rv-title', text: "Claude's reasoning, rebuilt from its work" })
  if (!result) return notReviewed(el, review)
  el.createEl('p', { cls: 'rv-sub', text: 'Rebuilt from what Claude said, which files it read, and what it changed. Problems come first.' })
  const order = ['shortcut', 'unrequested', 'skipped', 'decision', 'plan', 'explored']
  const steps = [...result.steps].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
  for (const step of steps) {
    const card = el.createDiv({ cls: 'rv-card' })
    const head = card.createDiv({ cls: 'rv-card-hd' })
    chip(head, step.kind, STEP_TONES[step.kind] || 'muted')
    head.createEl('span', { cls: 'rv-strong rv-grow', text: step.title })
    const source = SOURCES[step.source] || SOURCES.none
    chip(head, source.label, source.tone)
    if (step.why) card.createEl('p', { text: step.why })
    renderEvidence(card, step.evidence, project, plugin)
  }
}

// ---------- right sidebar: files, Trace, steer ----------

class SideView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf)
    this.plugin = plugin
  }
  getViewType() {
    return SIDE_VIEW
  }
  getDisplayText() {
    return 'Rearview turn'
  }
  getIcon() {
    return 'git-compare'
  }
  async onOpen() {
    this.render()
  }

  render() {
    const el = this.contentEl
    el.empty()
    el.addClass('rv', 'rv-side')
    const shown = this.plugin.current()
    if (!shown) {
      el.createDiv({ cls: 'rv-muted rv-pad', text: 'No turn selected.' })
      return
    }
    const { project, turn, label } = shown
    if (turn.files === null) return

    sectionTitle(el, `${label} · files`)
    const files = el.createDiv({ cls: 'rv-list' })
    if (turn.files.length === 0) files.createDiv({ cls: 'rv-muted', text: 'No files changed.' })
    for (const file of turn.files) {
      const row = files.createEl('button', { cls: 'rv-row' })
      row.createEl('span', { cls: 'rv-mono rv-row-title', text: file.path })
      if (file.change === 'new') chip(row, 'New', 'green')
      counts(row, file.added, file.removed)
      row.addEventListener('click', () => this.plugin.scrollToFile(file.path))
    }
    if (turn.affected && turn.affected.length) {
      const affected = el.createDiv({ cls: 'rv-affected' })
      affected.createEl('span', { cls: 'rv-muted', text: 'Affected, not edited' })
      for (const file of turn.affected) affected.createEl('span', { cls: 'rv-mono rv-orange-text', text: file })
    }

    sectionTitle(el, 'Trace')
    this.renderTrace(el)

    sectionTitle(el, 'Steer the next turn')
    const steer = el.createDiv({ cls: 'rv-steer' })
    steer.createEl('label', { cls: 'rv-muted', text: 'Tell Claude what to do instead', attr: { for: 'rv-steer-text' } })
    const text = steer.createEl('textarea', { attr: { id: 'rv-steer-text', rows: '4' } })
    text.value = this.plugin.draft
    text.addEventListener('input', () => (this.plugin.draft = text.value))
    const rememberRow = steer.createEl('label', { cls: 'rv-check' })
    const remember = rememberRow.createEl('input', { attr: { type: 'checkbox' } })
    rememberRow.createEl('span', { text: 'Suggest this as a principle' })
    const send = steer.createEl('button', { cls: 'mod-cta', text: 'Send to Claude' })
    send.addEventListener('click', async () => {
      if (await this.plugin.sendSteer(project.root, text.value, remember.checked)) {
        this.plugin.draft = ''
        text.value = ''
        remember.checked = false
      }
    })
  }

  renderTrace(el) {
    const trace = this.plugin.trace
    const box = el.createDiv({ cls: 'rv-trace' })
    if (!trace) {
      box.createDiv({ cls: 'rv-muted', text: 'Click Trace beside a Why note to see where a name is defined and used.' })
      return
    }
    box.createDiv({ cls: 'rv-muted', text: 'Tracing' })
    box.createDiv({ cls: 'rv-mono rv-strong', text: trace.symbol })
    if (trace.state === 'running') return box.createDiv({ cls: 'rv-muted', text: 'Searching…' })
    if (trace.state === 'failed') return box.createDiv({ cls: 'rv-muted', text: 'Trace needs git, and the project to be a git repository.' })
    for (const [title, hits] of [['Defined in', trace.definitions], ['Also used in', trace.uses]]) {
      const card = box.createDiv({ cls: 'rv-card rv-tight' })
      card.createDiv({ cls: 'rv-muted rv-strong', text: title })
      if (hits.length === 0) card.createDiv({ cls: 'rv-muted', text: 'Nowhere else.' })
      for (const hit of hits) {
        const row = card.createEl('button', { cls: 'rv-hit', attr: { title: hit.text } })
        row.createEl('span', { cls: 'rv-mono', text: `${hit.file}:${hit.line}` })
        row.createEl('span', { cls: 'rv-hit-text', text: hit.text })
        row.addEventListener('click', () => this.plugin.openProjectFile(trace.root, hit.file))
      }
    }
  }
}

// ---------- settings ----------

class RearviewSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display() {
    const el = this.containerEl
    el.empty()
    new Setting(el)
      .setName('Project folders')
      .setDesc('One full path per line, for each project you use Claude Code in, e.g. /Users/you/code/my-app.')
      .addTextArea(area => {
        area.setValue(this.plugin.settings.projects.join('\n'))
        area.inputEl.rows = 5
        area.inputEl.addEventListener('blur', async () => {
          this.plugin.settings.projects = area.getValue().split('\n').map(line => line.trim()).filter(Boolean)
          await this.plugin.saveSettings()
        })
      })
    new Setting(el)
      .setName('Open when a new turn arrives')
      .setDesc('Bring Rearview forward each time Claude finishes a turn in a connected project.')
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.openOnNewTurn).onChange(async value => {
          this.plugin.settings.openOnNewTurn = value
          await this.plugin.saveSettings()
        }),
      )
  }
}

module.exports = RearviewPlugin
module.exports.testing = { parseDiff, score, titleOf, parseGrepLine, parseImports, resolveImport, buildMap, githubRepo, checkGitConnection, parseGitPatch, loadWorkingTree, loadCommits, loadCommitFiles }
