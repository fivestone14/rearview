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

test('the gaps message lists what is partly done, missed, unrequested or against a principle, and nothing else', () => {
  const result = {
    requirements: [
      { id: 'R1', text: 'Add a toggle', status: 'done', finding: 'Added' },
      { id: 'R2', text: 'Add tests', status: 'missed', finding: 'No tests' },
    ],
    steps: [{ kind: 'unrequested', title: 'Changed the radius' }, { kind: 'decision', title: 'Used context' }],
    violations: [{ principleId: 'tests-required', finding: 'No tests added' }],
  }
  const message = t.gapsMessage(result)
  assert.match(message, /It can be wrong/)
  assert.match(message, /1\. Add tests \(missed\): No tests/)
  assert.match(message, /2\. Not requested: Changed the radius/)
  assert.match(message, /3\. Goes against principle "tests-required"/)
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

test('uncommitted changes and commits load like turns, secrets hidden', async () => {
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
  assert.strictEqual(commit.request, 'First commit')
  assert.deepStrictEqual((await t.loadCommitFiles(repo, commit.sha)).map(f => [f.path, f.added]), [['a.ts', 2]])
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
