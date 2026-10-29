// Tests for Rearview's Obsidian plugin, run with `node obsidian/test.js`. No dependencies: Obsidian's module is
// stood in for, so the logic runs under plain Node. Git tests make throwaway repositories in the temp folder.

const Module = require('module')
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const notices = []
const load = Module._load
Module._load = function (request, ...rest) {
  if (request !== 'obsidian') return load.call(this, request, ...rest)
  class Stand {}
  class Notice {
    constructor(message) {
      notices.push(message)
    }
  }
  return { ItemView: Stand, Modal: Stand, Notice, Plugin: Stand, PluginSettingTab: Stand, SecretComponent: Stand, Setting: Stand, requestUrl: null, setIcon: () => {} }
}
const Rearview = require('./main.js')
const t = Rearview.testing

const tests = []
const test = (name, fn) => tests.push({ name, fn })
const row = fields => JSON.stringify(fields)
const settings = (preset, extra = {}) => ({ preset, auto: true, models: {}, keyNames: {}, baseUrl: '', ...extra })
const reply = json => async () => ({ status: 200, json, text: JSON.stringify(json) })

// ---------- turns from transcripts ----------

test('a transcript becomes turns: prompts typed by a person, and steers from Rearview', () => {
  const text = [
    row({ type: 'user', uuid: 'u1', sessionId: 's', timestamp: '2026-10-27T10:00:00Z', origin: { kind: 'human' }, message: { content: 'Add a toggle' } }),
    row({ type: 'assistant', timestamp: '2026-10-27T10:00:01Z', message: { content: [{ type: 'text', text: 'Adding it.' }, { type: 'tool_use', id: 't1', name: 'Edit', input: {} }, { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/p/src/b.ts' } }] } }),
    row({ type: 'user', timestamp: '2026-10-27T10:00:02Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] }, toolUseResult: { filePath: '/p/src/a.ts', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] } }),
    row({ type: 'user', timestamp: '2026-10-27T10:00:03Z', origin: { kind: 'task-notification' }, message: { content: '<task-notification>done</task-notification>' } }),
    row({ type: 'user', uuid: 'p1', timestamp: '2026-10-27T10:01:00Z', message: { content: 'Reply with just: OK' } }),
    row({ type: 'user', uuid: 'st', sessionId: 's', timestamp: '2026-10-27T10:02:00Z', message: { content: 'A correction from the Rearview review in Obsidian: add the tests' } }),
  ].join('\n')
  const turns = t.parseTranscript(text, '/p')
  assert.deepStrictEqual(turns.map(x => [x.request, !!x.isSteer]), [['Add a toggle', false], ['add the tests', true]])
  assert.deepStrictEqual(turns[0].files.map(f => [f.path, f.added, f.removed]), [['src/a.ts', 1, 1]])
  assert.deepStrictEqual(turns[0].filesRead, ['src/b.ts'])
  assert.strictEqual(turns[0].answer, 'Adding it.')
})

test('a new file written by Claude is all added lines; a secret file keeps its name only', () => {
  const text = [
    row({ type: 'user', uuid: 'u1', timestamp: '2026-10-27T10:00:00Z', origin: { kind: 'human' }, message: { content: 'Set up' } }),
    row({ type: 'user', timestamp: '2026-10-27T10:00:01Z', message: { content: [] }, toolUseResult: { type: 'create', filePath: '/p/new.ts', content: 'one\ntwo\n', structuredPatch: [] } }),
    row({ type: 'user', timestamp: '2026-10-27T10:00:02Z', message: { content: [] }, toolUseResult: { type: 'create', filePath: '/p/.env', content: 'API_KEY=hunter2\n', structuredPatch: [] } }),
  ].join('\n')
  const [turn] = t.parseTranscript(text, '/p')
  assert.deepStrictEqual(turn.files.map(f => [f.path, f.change, f.added, !!f.isSecret]), [['new.ts', 'new', 2, false], ['.env', 'new', 1, true]])
  assert.ok(!JSON.stringify(turn).includes('hunter2'))
})

test('diffs, scores and titles read the way the views need them', () => {
  const rows = t.parseDiff('--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n')
  assert.deepStrictEqual(rows.map(r => [r.kind, r.newNo ?? null]), [['hunk', null], ['same', 1], ['del', null], ['add', 2], ['same', 3]])
  const done = s => ({ status: s })
  assert.strictEqual(t.score({ files: [1], review: { state: 'done', result: { requirements: [done('done'), done('partly')] } } }).label, '1/2')
  assert.strictEqual(t.score({ files: [], review: { state: 'skipped' } }).label, 'no edits')
  assert.strictEqual(t.titleOf('<artifact-view-context a="1">{}</artifact-view-context>\n\nReorganize it'), 'Reorganize it')
})

test('relative imports resolve to project paths; package imports do not', () => {
  assert.strictEqual(t.resolveImport('src/settings/Panel.tsx', '../theme/Theme'), 'src/theme/Theme')
  assert.strictEqual(t.resolveImport('pkg/a.py', '..theme.colors'), 'theme/colors')
  assert.strictEqual(t.resolveImport('a.ts', 'react'), null)
})

// ---------- reviews ----------

test('a review reply is read tolerantly, and a reply that is not a review is refused', () => {
  const fenced = '```json\n' + JSON.stringify({ requirements: [{ text: 'Add toggle', status: 'done' }, { status: 'done' }], notes: [{ file: 'a.ts', line: 2, why: 'Adds it', symbols: ['toggle', 'not a name'] }], steps: [{ kind: 'weird', title: 'Did it' }] }) + '\n```'
  const review = t.parseReview(fenced)
  assert.deepStrictEqual(review.requirements.map(r => r.id), ['R1'])
  assert.deepStrictEqual(review.notes[0].symbols, ['toggle'])
  assert.strictEqual(review.steps[0].kind, 'decision')
  assert.strictEqual(t.parseReview('Sorry, I cannot help with that.'), null)
})

test('API presets send the right request, with keys from secret storage', async () => {
  const calls = []
  const capture = respond => async request => (calls.push(request), respond(request))
  assert.strictEqual(await t.runModel(settings('ollama', { models: { ollama: 'qwen' } }), 'S', 'P', async () => null, capture(reply({ choices: [{ message: { content: 'hi' } }] }))), 'hi')
  assert.strictEqual(calls[0].url, 'http://localhost:11434/v1/chat/completions')
  assert.deepStrictEqual(calls[0].headers, {})
  assert.strictEqual(await t.runModel(settings('anthropic', { keyNames: { anthropic: 'mine' } }), 'S', 'P', async name => (name === 'mine' ? 'sk-test' : null), capture(reply({ content: [{ type: 'text', text: 'yo' }] }))), 'yo')
  assert.strictEqual(calls[1].headers['x-api-key'], 'sk-test')
  await t.runModel(settings('custom', { baseUrl: 'http://localhost:8765/v1/', models: { custom: 'm' }, keyNames: { custom: 'k' } }), 'S', 'P', async () => 'abc', capture(reply({ choices: [{ message: { content: 'c' } }] })))
  assert.strictEqual(calls[2].url, 'http://localhost:8765/v1/chat/completions')
  assert.strictEqual(calls[2].headers.Authorization, 'Bearer abc')
})

test('a model that cannot be reached or used says why in plain words', async () => {
  const fails = (promise, pattern) => assert.rejects(promise, error => pattern.test(error.message))
  await fails(t.runModel(settings('openai', { models: { openai: 'm' } }), 'S', 'P', async () => null, reply({})), /Add your OpenAI API key/)
  await fails(t.runModel(settings('openai', { models: { openai: 'm' }, keyNames: { openai: 'k' } }), 'S', 'P', async () => 'bad', async () => ({ status: 401, json: {} })), /key was refused/)
  await fails(t.runModel(settings('ollama', { models: { ollama: 'q' } }), 'S', 'P', async () => null, async () => { throw new Error('ECONNREFUSED') }), /Is Ollama running\?/)
  await fails(t.runModel(settings('openrouter'), 'S', 'P', async () => 'k', reply({})), /Choose a model/)
})

test('local models list themselves for the model picker', async () => {
  const names = await t.listModels(settings('lmstudio'), async () => null, reply({ data: [{ id: 'qwen' }, { id: 'llama' }] }))
  assert.deepStrictEqual(names, ['llama', 'qwen'])
})

test('Claude Code reviews run as a plain model call: no tools, hooks or MCP servers, nothing saved', () => {
  const args = t.cliArgs('claude-code', 'haiku', 'SYSTEM')
  for (const flag of ['--no-session-persistence', '--strict-mcp-config', '--tools', '--settings']) assert.ok(args.includes(flag), flag)
  assert.strictEqual(args[args.indexOf('--settings') + 1], '{"disableAllHooks":true}')
  assert.throws(() => t.cliReply('claude-code', JSON.stringify({ is_error: true, result: 'Not logged in' })), /Not logged in/)
})

test('the request card shows only the person\'s words, not the context Claude Code wraps around them', () => {
  const request = '<artifact-view-context artifact="x">\n{"context":{}}\n(The JSON line above…)\n<artifact-content-authored-by-others/>\n</artifact-view-context>\n\nWhere are we on this project?'
  assert.strictEqual(t.requestText(request), 'Where are we on this project?')
  assert.strictEqual(t.titleOf(request), 'Where are we on this project?')
  assert.strictEqual(t.requestText('Line one\n\nLine two'), 'Line one\n\nLine two')
})

test('the gaps message lists what is partly done, missed, unrequested or against a guardrail, and nothing else', () => {
  const result = {
    requirements: [
      { id: 'R1', text: 'Add a toggle', status: 'done', finding: 'Added' },
      { id: 'R2', text: 'Add tests', status: 'missed', finding: 'No tests' },
    ],
    steps: [{ kind: 'unrequested', title: 'Changed the radius' }, { kind: 'decision', title: 'Used context' }],
    violations: [{ guardrail: 'Add tests for new behavior', finding: 'No tests added' }],
  }
  const message = t.gapsMessage(result)
  assert.match(message, /It can be wrong/)
  assert.match(message, /1\. Add tests \(missed\): No tests/)
  assert.match(message, /2\. Not requested: Changed the radius/)
  assert.match(message, /3\. Goes against the guardrail "Add tests for new behavior"/)
  assert.doesNotMatch(message, /Add a toggle|Used context/)
  assert.strictEqual(t.gapsMessage({ requirements: [result.requirements[0]], steps: [], violations: [] }), '')
})

test('the sidebar shows commits ahead of and behind GitHub, or nothing without an upstream', () => {
  assert.strictEqual(t.syncLabel({ ahead: 3, behind: 0 }), '↑3')
  assert.strictEqual(t.syncLabel({ ahead: 1, behind: 2 }), '↑1 ↓2')
  assert.strictEqual(t.syncLabel({ ahead: 0, behind: 0 }), 'in sync')
  assert.strictEqual(t.syncLabel({ ahead: null, behind: null }), '')
})

test('a steer needs words and a conversation to continue', async () => {
  const fake = { steering: null, refresh: () => {} }
  assert.strictEqual(await Rearview.prototype.steer.call(fake, '/p', { sessionId: 's' }, '   '), false)
  assert.strictEqual(await Rearview.prototype.steer.call(fake, '/p', { isGit: true }, 'Add tests'), false)
  assert.deepStrictEqual(notices.slice(-2), ['Write what Claude should do instead first.', 'This has no Claude Code conversation to continue. Use Copy and paste it into Claude Code.'])
})

// ---------- changes: the story order, the turns behind them, and when a review is out of date ----------

test('files are ordered so a file comes before the files that import it, and unlinked files come last', () => {
  const edges = [
    { from: 'src/App.tsx', to: 'src/theme/ThemeContext.tsx' },
    { from: 'src/settings/SettingsPanel.tsx', to: 'src/theme/ThemeContext.tsx' },
    { from: 'src/theme/ThemeContext.tsx', to: 'src/hooks/useLocalStorage.ts' },
  ]
  const paths = ['src/settings/SettingsPanel.tsx', 'src/theme/theme.css', 'src/App.tsx', 'src/theme/ThemeContext.tsx']
  assert.deepStrictEqual(t.buildOrder(paths, edges), ['src/theme/ThemeContext.tsx', 'src/settings/SettingsPanel.tsx', 'src/App.tsx', 'src/theme/theme.css'])
  // An import cycle cannot be ordered, so its files keep their place instead of being dropped.
  assert.deepStrictEqual(t.buildOrder(['a', 'b'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]), ['a', 'b'])
})

test('the Connections list puts helpers just before the file using them and affected files just after', () => {
  const nodes = [{ path: 'ctx', kind: 'new' }, { path: 'panel', kind: 'edited' }, { path: 'store', kind: 'untouched' }, { path: 'header', kind: 'affected' }]
  const edges = [{ from: 'ctx', to: 'store' }, { from: 'panel', to: 'ctx' }, { from: 'header', to: 'ctx' }]
  assert.deepStrictEqual(t.flowList(['ctx', 'panel'], nodes, edges), ['store', 'ctx', 'header', 'panel'])
})

test('the turns behind changes are those that edited the files since the last commit; other files have no Claude edit recorded', () => {
  const turn = (id, startedAt, finishedAt, files) => ({ id, startedAt, finishedAt, files: files.map(p => ({ path: p })) })
  const turns = [turn('old', 0, 50, ['a.ts']), turn('mine', 120, 200, ['a.ts', 'gone.ts']), turn('other', 130, 210, ['z.ts'])]
  const { turns: matched, byClaude } = t.matchTurns(turns, [{ path: 'a.ts' }, { path: 'b.ts' }], 100)
  assert.deepStrictEqual(matched.map(x => x.id), ['mine'])
  assert.deepStrictEqual([...byClaude], ['a.ts'])
  assert.deepStrictEqual(t.matchTurns(turns, [{ path: 'a.ts' }], 0, 60).turns.map(x => x.id), ['old'])
})

test('a review knows when the changes moved on since it ran', () => {
  const files = [{ path: 'a.ts', change: 'edited', diff: '@@ -1 +1 @@\n-a\n+b' }]
  assert.strictEqual(t.changeSignature(files), t.changeSignature(files.map(f => ({ ...f }))))
  assert.notStrictEqual(t.changeSignature(files), t.changeSignature([{ ...files[0], diff: '@@ -1 +1 @@\n-a\n+c' }]))
})

test('the review is asked about files in story order, told which ones have no Claude edit recorded, and its new fields are read', () => {
  const prompt = t.reviewPrompt({
    requests: ['Add dark mode'],
    files: [{ path: 'b.ts', change: 'edited', diff: '+b' }, { path: 'a.ts', change: 'new', diff: '+a' }],
    order: ['a.ts', 'b.ts'],
    edges: [{ from: 'b.ts', to: 'a.ts' }],
    outside: ['b.ts'],
    guardrails: ['Add tests'],
    filesRead: [],
    agentMessages: '',
  })
  assert.match(prompt, /FILES IN ORDER:\na\.ts\nb\.ts/)
  assert.match(prompt, /NO AGENT EDIT RECORDED[^\n]*:\nb\.ts/)
  assert.match(prompt, /CONNECTIONS:\nb\.ts -> a\.ts/)
  assert.match(prompt, /GUARDRAILS:\nAdd tests/)
  assert.ok(prompt.indexOf('### a.ts') < prompt.indexOf('### b.ts'))
  const review = t.parseReview(JSON.stringify({
    files: [{ file: 'a.ts', did: 'Added it', effect: 'Theme is shared', next: 'b.ts uses it' }],
    links: [{ from: 'b.ts', to: 'a.ts', how: 'reads the theme' }, { from: 'x' }],
    violations: [{ guardrail: 'Add tests', finding: 'None added', evidence: [{ file: 'a.ts' }] }],
  }))
  assert.deepStrictEqual(review.files, [{ file: 'a.ts', did: 'Added it', why: '', effect: 'Theme is shared', next: 'b.ts uses it', changes: [] }])
  assert.deepStrictEqual(review.links, [{ from: 'b.ts', to: 'a.ts', how: 'reads the theme' }])
  assert.strictEqual(review.violations[0].guardrail, 'Add tests')
  // A review saved before these fields existed still draws, with each list empty.
  assert.deepStrictEqual(t.resultOf({ state: 'done', result: { requirements: [], notes: [], steps: [] } }).links, [])
})

test('flags go on the file their evidence points to, each with a message to guide Claude', () => {
  const result = {
    requirements: [{ id: 'R1', text: 'Toggle', status: 'done', evidence: [{ file: 'a.ts' }] }, { id: 'R2', text: 'Follow system', status: 'partly', finding: 'Only at start', evidence: [{ file: 'a.ts', line: 4 }] }],
    steps: [{ kind: 'unrequested', title: 'Changed radius', why: '', evidence: [{ file: 'b.css' }] }, { kind: 'decision', title: 'Shared store', evidence: [{ file: 'a.ts' }] }],
    violations: [],
  }
  assert.deepStrictEqual(t.flagsFor('a.ts', result).map(f => [f.kind, f.text]), [['partly', 'R2 Follow system: Only at start']])
  const [extra] = t.flagsFor('b.css', result)
  assert.strictEqual(extra.kind, 'not asked for')
  assert.match(extra.draft, /Revert "Changed radius" in b\.css/)
  const linked = new Set(['a.ts', 'b.ts'])
  assert.strictEqual(t.thenLine(null, 'a.ts', 'b.ts', [{ from: 'b.ts', to: 'a.ts' }], linked), 'b.ts uses a.ts.')
  // A file no import links to the others gets no "Then" line, even when the review wrote one.
  assert.strictEqual(t.thenLine({ next: 'README.md describes these tests.' }, 'b.ts', 'README.md', [{ from: 'b.ts', to: 'a.ts' }], linked), '')
})

test('changes are reviewed by themselves only once the files and Claude have both gone quiet, and once per version', () => {
  const now = Date.now()
  const files = [{ path: 'a.ts', change: 'edited', diff: '+a', added: 1, removed: 0 }]
  const started = []
  const make = ({ changedAt, workedAt, review }) => {
    const plugin = Object.create(Rearview.prototype)
    const root = '/p'
    Object.assign(plugin, {
      settings: { review: { auto: true } },
      startedAt: now - 10 * 60000,
      reviews: review ? { [`wt:${root}`]: review } : {},
      startReview: (r, id) => started.push(id),
      projects: new Map([[root, {
        root,
        turns: [{ id: 't', sessionId: 's', request: 'Do it', startedAt: workedAt - 1000, finishedAt: workedAt, files: [{ path: 'a.ts' }], filesRead: [], agentMessages: '' }],
        git: { isRepo: true, changedAt, commits: [], worktree: { id: `wt:${root}`, isWorktree: true, files } },
      }]]),
    })
    return plugin
  }
  const quiet = now - 60000
  const run = options => {
    started.length = 0
    make(options).autoReview()
    return started.length
  }
  assert.strictEqual(run({ changedAt: 0, workedAt: quiet }), 0, 'changes found at start-up wait for a click')
  assert.strictEqual(run({ changedAt: now - 5000, workedAt: quiet }), 0, 'files still changing')
  assert.strictEqual(run({ changedAt: quiet, workedAt: now - 5000 }), 0, 'Claude still working')
  assert.strictEqual(run({ changedAt: quiet, workedAt: quiet }), 1, 'both quiet')
  const signature = t.changeSignature(files)
  assert.strictEqual(run({ changedAt: quiet, workedAt: quiet, review: { state: 'done', signature } }), 0, 'already reviewed')
  assert.strictEqual(run({ changedAt: quiet, workedAt: quiet, review: { state: 'failed', signature } }), 0, 'a failed review is not retried by itself')
  assert.strictEqual(run({ changedAt: quiet, workedAt: quiet, review: { state: 'done', signature: 'older' } }), 1, 'the files moved on')
})

test('a file gets a numbered breakdown only with two or more real changes, and its links only to files really connected', () => {
  const review = t.parseReview(JSON.stringify({ files: [{ file: 'src/ctx.ts', did: 'Holds the theme.', changes: [
    { title: 'Lets any screen ask for the theme', from: 20, to: 22, what: 'A shortcut.', used: [{ file: 'Panel.tsx', line: 6, how: 'the switch' }, { file: 'Made/Up.ts', how: 'guess' }] },
    { title: 'Checks the system setting', from: 4, what: 'Once at start.' },
    { title: 'No line', what: 'dropped' },
  ] }] }))
  const info = review.files[0]
  assert.deepStrictEqual(info.changes.map(c => [c.title, c.from, c.to]), [['Checks the system setting', 4, 4], ['Lets any screen ask for the theme', 20, 22]])
  const map = { nodes: [], edges: [{ from: 'src/Panel.tsx', to: 'src/ctx.ts' }] }
  const changes = t.breakdownOf(info, 'src/ctx.ts', map, ['src/ctx.ts'])
  assert.deepStrictEqual(changes[1].used, [{ file: 'src/Panel.tsx', line: 6, how: 'the switch' }])
  assert.strictEqual(t.changeAt(changes, 21), 1)
  assert.strictEqual(t.changeAt(changes, 10), -1)
  assert.deepStrictEqual(t.breakdownOf({ changes: [changes[0]] }, 'src/ctx.ts', map, []), [], 'one change: the lead line says it all')
  assert.deepStrictEqual(t.breakdownOf({ did: 'old review' }, 'src/ctx.ts', map, []), [], 'reviews saved before breakdowns still draw')
})

test('one file can be reviewed alone, and its card draws on whichever review finished last', () => {
  assert.strictEqual(t.reviewKey('wt:/p', null), 'wt:/p')
  assert.strictEqual(t.reviewKey('wt:/p', 'src/a.ts'), 'wt:/p#src/a.ts')
  const whole = { state: 'done', reviewedAt: 100 }
  const own = { state: 'done', reviewedAt: 200 }
  assert.strictEqual(t.pickReview(whole, own), own)
  assert.strictEqual(t.pickReview({ ...whole, reviewedAt: 300 }, own).reviewedAt, 300)
  assert.strictEqual(t.pickReview(whole, { state: 'pending' }), whole, 'a running review is not drawn from')
  assert.strictEqual(t.pickReview(null, { state: 'failed', reviewedAt: 999 }), null)
  const plugin = Object.create(Rearview.prototype)
  Object.assign(plugin, { reviews: {}, reviewQueue: [], refresh() {}, runReviews() {} })
  plugin.startReview('/p', 'wt:/p', 'src/a.ts')
  plugin.startReview('/p', 'wt:/p', 'src/a.ts')
  assert.deepStrictEqual(plugin.reviewQueue, [{ root: '/p', id: 'wt:/p', file: 'src/a.ts' }], 'queued once')
  assert.strictEqual(plugin.reviews['wt:/p#src/a.ts'].state, 'pending')
  assert.strictEqual(plugin.reviews['wt:/p'], undefined, 'the whole change keeps its own review')
})

test('after a review each change says what and why, and every flag is gathered under Still to do with its file', () => {
  const review = t.parseReview(JSON.stringify({ files: [{ file: 'a.ts', did: 'Did it.', why: 'Because.', changes: [{ title: 'One', from: 1, what: 'Does one.', why: 'Needed for two.' }] }] }))
  assert.strictEqual(review.files[0].why, 'Because.')
  assert.strictEqual(review.files[0].changes[0].why, 'Needed for two.')
  const result = {
    requirements: [{ id: 'R1', text: 'Tests', status: 'missed', finding: 'None', evidence: [] }, { id: 'R2', text: 'Toggle', status: 'partly', finding: 'Half', evidence: [{ file: 'a.ts', line: 3 }] }],
    steps: [], violations: [{ guardrail: 'Reuse helpers', finding: 'New helper', evidence: [] }],
  }
  const fromCards = t.flagsFor('a.ts', result).map(f => ({ ...f, file: 'a.ts' }))
  const todo = t.stillToDo(fromCards, result, new Set(['a.ts']))
  assert.deepStrictEqual(todo.map(f => [f.kind, f.file]), [['partly', 'a.ts'], ['missed', ''], ['guardrail', '']])
})

// ---------- Git ----------

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' })

test('the Git connection check refuses a folder outside a repository and passes one inside', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'rearview-plain-'))
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rearview-repo-'))
  git(repo, 'init', '-q')
  fs.writeFileSync(path.join(repo, 'a.ts'), 'a\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'First commit')
  assert.strictEqual((await t.checkGitConnection(plain)).isOk, false)
  assert.strictEqual((await t.checkGitConnection(path.join(plain, 'missing'))).isOk, false)
  const result = await t.checkGitConnection(repo)
  assert.strictEqual(result.isOk, true)
  assert.ok(result.steps.some(step => step.label === 'Remote' && step.status === 'warn'))
  assert.strictEqual(t.githubRepo('git@github.com:me/app.git'), 'me/app')
})

test('uncommitted changes and commits load with secrets hidden', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rearview-repo-'))
  git(repo, 'init', '-q')
  fs.writeFileSync(path.join(repo, 'a.ts'), 'a\nb\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'First commit')
  fs.writeFileSync(path.join(repo, 'a.ts'), 'a\nB\n')
  fs.writeFileSync(path.join(repo, 'new.ts'), 'export {}\n')
  fs.writeFileSync(path.join(repo, '.env'), 'API_KEY=hunter2\n')
  const worktree = await t.loadWorkingTree(repo)
  assert.deepStrictEqual(worktree.files.map(f => [f.path, f.change, !!f.isSecret]).sort(), [['.env', 'new', true], ['a.ts', 'edited', false], ['new.ts', 'new', false]])
  assert.ok(!JSON.stringify(worktree).includes('hunter2'))
  const [commit] = await t.loadCommits(repo)
  assert.strictEqual(commit.message, 'First commit')
  assert.deepStrictEqual((await t.loadCommitFiles(repo, commit.sha)).map(f => [f.path, f.added]), [['a.ts', 2]])
})

test('the Map finds unchanged files that import a changed file, and the working tree is reviewed per project', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rearview-repo-'))
  git(repo, 'init', '-q')
  fs.mkdirSync(path.join(repo, 'src'))
  fs.writeFileSync(path.join(repo, 'src/theme.ts'), 'export const theme = 1\n')
  fs.writeFileSync(path.join(repo, 'src/Header.tsx'), "import { theme } from './theme'\nexport const h = theme\n")
  fs.writeFileSync(path.join(repo, 'src/other.ts'), "// mentions theme but imports nothing\n")
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'First commit')
  fs.writeFileSync(path.join(repo, 'src/theme.ts'), 'export const theme = 2\n')
  const worktree = await t.loadWorkingTree(repo)
  assert.strictEqual(worktree.id, `wt:${repo}`)
  assert.deepStrictEqual(await t.findImporters(repo, worktree.files), ['src/Header.tsx'])
  const map = await t.buildMap(repo, worktree.files)
  assert.deepStrictEqual(map.nodes.map(n => [n.path, n.kind]), [['src/theme.ts', 'edited'], ['src/Header.tsx', 'affected']])
  assert.deepStrictEqual(map.edges, [{ from: 'src/Header.tsx', to: 'src/theme.ts' }])
})

// ---------- run ----------

;(async () => {
  let failed = 0
  for (const { name, fn } of tests) {
    try {
      await fn()
      console.log(`pass  ${name}`)
    } catch (error) {
      failed++
      console.log(`FAIL  ${name}\n      ${error.message}`)
    }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})()
