# Rearview

A Claude Code plugin that reviews every turn Claude takes, for people who write code and people who don't.

After each turn, a pane beside the chat answers three questions:

1. **Did it do what I asked?** Your request split into parts, each marked *done*, *partly* or *missed*, with the file and line that shows it.
2. **What changed, and why?** Each changed file's diff, with a plain-English reason under the lines that matter. Each reason says where it comes from: *Claude said so*, *inferred* from the code, or *no reason found*. Click **Trace** on a name to see where it is defined and used, without opening other files.
3. **How should it work next time?** Claude's reasoning rebuilt as steps, with problems (shortcuts, unrequested changes, skipped work) first. Mark a step **Looks right** or **Steer** Claude with a correction. Steer the same way twice and Rearview suggests saving it as a **principle**, which Claude then follows in later sessions.

## Install

Rearview is a *mod*: a plugin of function hooks. It needs Claude Code **2.1.287 or newer** (Desktop 2.1.286+, VS Code extension 2.1.299+). Mods are an early-access part of Claude Code and their API may change between releases.

From a folder on your computer (a clone of this repository):

```bash
claude plugin marketplace add /path/to/rearview
```

```bash
claude plugin install rearview@rearview
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace**, and enter the folder path. Then **Add plugin** and pick Rearview.

Because the marketplace is a folder, Claude Code reads the plugin straight from it. After editing the code, run `/reload-plugins` in a session.

## Using it on a project

There is no import step. Rearview reviews whichever folder the Claude Code session is working in: start a session in your project (in the desktop app, pick the project folder when you start the session) and work as usual.

- The pane opens by itself when the desktop app or VS Code attaches to the session. Anywhere else, or if it is closed, type `/rearview`.
- Each turn appears once Claude finishes. The review takes a few seconds more and shows **Reviewing this turn…** until it is ready.
- **Send the gaps to Claude** on the Check tab sends one follow-up listing everything partly done, missed, unrequested or against a principle.

## How it works

Everything is one hooks module, [`hooks/register.tsx`](hooks/register.tsx), which connects Claude Code's events to small files that each do one job:

| Event | What Rearview does | File |
|---|---|---|
| `session.start` | Loads saved turns and principles, adds `/rearview`, starts the reviewer timer | `register.tsx` |
| `session.attach` | Opens the pane when a desktop or VS Code window attaches | `register.tsx` |
| `prompt.submit` | **Drift check**: if a prompt you typed goes against an active principle, holds it and asks above the prompt (*Just this once* / *Retire the principle* / *Cancel*) | `principles.ts` |
| `turn.start` | Starts recording a turn | `turn.ts` |
| `tool.call` | Refuses edits a *blocking* principle forbids; remembers files Claude reads, and each file's content before Claude's first edit | `turn.ts`, `principles.ts` |
| `turn.complete` | Diffs each edited file, finds files changed by shell commands (against a git snapshot taken when the turn started), finds files that import a changed file | `turn.ts`, `diff.ts`, `trace.ts` |
| timer (every 2 s) | Reviews the next finished turn with one model call: checklist, why-notes, reasoning steps, principle violations | `review.ts` |
| `prompt.compose` | Adds active principles to Claude's system prompt | `principles.ts` |
| `ui.render` | Draws the pane and the drift question | `pane.tsx` |

The other files:

| File | Job |
|---|---|
| `hooks/state.ts` | The only file that reads or writes session state; writing redraws the pane |
| `hooks/actions.ts` | What each button in the pane does |
| `hooks/paths.ts` | Project-relative paths, file reads and writes, running git in the project |
| `types/index.d.ts` | Every data shape Rearview keeps, and its session state contract |
| `tests/rearview.test.tsx` | Tests for the logic and for a full turn through the engine |

### What it stores

| Where | What |
|---|---|
| `.claude/rearview/principles.md` in your project | Your principles. Plain Markdown: read it, edit it, commit it to share with your team. |
| `.claude/rearview/signals.jsonl` in your project | Every *Looks right* and *Steer*, the evidence principles are suggested from |
| Claude Code's plugin store | The last 20 turns per project, with their reviews |
| `.claude/rearview/turns.json` in your project | The same turns and reviews, without Claude's full messages, for the Obsidian view |
| `.claude/rearview/session.json` and `inbox.jsonl` in your project | This session's random code, and steers sent from Obsidian waiting to be read |

A principle looks like this:

```markdown
## tests-required
- rule: New behavior ships with tests.
- scope: everywhere
- enforce: block
- files: package.json
- status: active
- signals: 2
```

`enforce` decides how strongly it applies: **guide** (Claude reads it), **warn** (the review also checks changes against it), **block** (also refuses edits to files matching `files`).

### Privacy

Rearview uses no third-party services and makes no network calls of its own. The review, drift check and principle suggestions are model calls made through your Claude Code session's own connection, so your request, the diffs and Claude's replies for each turn are sent to Anthropic the same way your conversation is. Choose the models under the plugin's settings (`reviewModel`, default `sonnet`; `checkModel`, default `haiku`).

The last 20 turns, with their diffs, are kept on your computer in Claude Code's plugin store so the pane can show them in later sessions, and in `.claude/rearview/turns.json` for the Obsidian view. Add `.claude/rearview/` to the project's `.gitignore` if you don't want them committed. A secret typed into an ordinary source file is part of its diff like any other line.

### Security

What Rearview can do is limited to what `claude plugin validate .` lists: read project files, write its files under `.claude/rearview/`, run `git` and `grep`, call the model, and send a prompt to Claude when you press a button, here or in the Obsidian view. A steer from Obsidian is sent only when it carries the random code Rearview made when this session started, so an inbox file that came with a cloned project cannot send anything. It opens no ports, loads no code from elsewhere and has no dependencies.

It is built for opening projects you did not write:

- **A principles file that comes with a project is never used until you approve it.** Rearview remembers a fingerprint of the file each time it writes it or you approve it. A file that arrives in a cloned repository, or changes outside Rearview, is shown in the Principles tab with a warning, but Claude does not see it, it blocks nothing, and it holds no prompts until you read it and press **Approve these principles**.
- **Nothing the review says reaches Claude without you seeing it first.** Project files can contain text written to mislead the review model, so **Send the gaps to Claude** shows the exact message and waits for **Send to Claude**, and the message itself tells Claude the review can be wrong.
- **Secret-looking files are never read.** `.env` files, private keys, credential and secrets files, Terraform state and similar names are listed by name only; their contents are not shown, stored or sent.
- **No command can be smuggled in.** `git` and `grep` run with argument lists, not a shell, with every file name after `--`; names the review model asks to trace must be plain identifiers.
- **A failing check never locks you out.** If the drift check or the edit guard itself fails, your prompt or tool call goes through.

Installing a plugin runs its code in every session, so read the code first; it is about 1,700 lines of TypeScript in `hooks/`.

## Obsidian

`obsidian/` is a desktop Obsidian plugin that shows the same reviews in a full-size layout: turns in the left sidebar, the turn in a tab (*Code*, *Check work*, *Reasoning*), and its files, Trace and a steer box in the right sidebar. It follows `.claude/rearview/turns.json` in each project you connect, so a new turn appears as soon as Claude finishes it.

1. Copy `obsidian/main.js`, `manifest.json` and `styles.css` to `<your vault>/.obsidian/plugins/rearview/`.
2. In Obsidian, turn on Rearview under **Settings › Community plugins**, then add your project folders in its settings.
3. Click the eye in the ribbon, or run **Rearview: Open the latest turn**.

**Send to Claude** in Obsidian reaches the Claude Code session open in that project within a few seconds, as your next message there.

## Limits

- **Edits through Claude's file tools are diffed exactly.** Files changed by shell commands are found only in a git repository with at least one commit: Rearview snapshots the working tree when the turn starts (`git stash create`, which leaves your files and branches untouched and only adds an unreferenced object to `.git`) and diffs against it when the turn ends. At most 50 such files are shown per turn; binary and very large new files are listed without a diff. Outside git, before the first commit, or mid-merge, only Claude's own file edits are seen.
- **Blocking covers Claude's file tools only.** A blocking principle refuses Edit, Write and NotebookEdit calls on matching files; it cannot stop a shell command from changing them.
- **The drift check only holds prompts you typed.** Prompts with attachments or `@file` mentions skip it, because a held prompt is resent as plain text.
- **Reasons are rebuilt, not read from Claude's mind.** Claude Code does not expose the model's private reasoning, so steps come from what Claude said, which files it read, and what it changed. That is why every reason is labelled.
- **Trace and imports are text search** (`git grep`, or `grep` outside git). Imports are understood for relative JavaScript/TypeScript and Python imports (including `from . import x`).
- **The Files tab shows the changed area**, not a whole-project graph: changed, affected and read files, and the uses and used-by lists of the file you select.

## Development

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

`validate` checks the manifest and that the hooks module uses the API as the engine allows. `test` runs `tests/rearview.test.tsx` against the engine itself, with no files, git or network.

## License

MIT. See [LICENSE](LICENSE).
