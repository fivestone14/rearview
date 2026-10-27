# Rearview

An Obsidian plugin for reviewing what an AI coding agent changed, built to be easier to follow than reading changes in an IDE.

While Claude Code works on your project, Rearview shows each request you made and what came of it: every file changed, with the diff, how the changed files connect, and where a name is defined and used. Where a review exists, it also shows why each change was made, whether the request was fully done, and Claude's reasoning rebuilt from its work. Everything sits in one Obsidian window, next to your notes.

## What to expect

- **Every request is a turn.** Each prompt you type in Claude Code (in the desktop app, the terminal or VS Code) becomes a turn in Rearview, with Claude's messages, the files it read, and each edit it made. Turns appear and grow while Claude works; there is nothing to import or refresh.
- **Code.** Each changed file's diff, line by line. Under a line that needs explaining, a *Why* note says why it changed and where that reason comes from: *Claude said so*, *inferred* from the code, or *no reason found*.
- **Map.** The changed files in the middle, the files that use them on the left, and the files they use on the right, with lines for "uses". Click a changed file to jump to its diff.
- **Check work and Reasoning.** Your request split into parts marked *done*, *partly* or *missed*, and Claude's steps rebuilt with problems first (shortcuts, unrequested changes, skipped work).
- **Trace.** Click **Trace** beside a Why note to see where a name is defined and used, without leaving the review.
- **Git.** Each project also lists its uncommitted changes, refreshed every few seconds, and its recent commits. Open one to see its diff and Map like a turn.
- **Steer.** Write what Claude should do instead and send it to the Claude Code session open in that project.

Rearview reads what Claude Code already saves, so it never sees Claude's private reasoning. Reasons and steps are rebuilt from what Claude said, read and changed, and each one says where it came from.

## Requirements

- **Obsidian** for desktop (macOS, Windows or Linux). The mobile apps are not supported.
- **Claude Code**, a recent version. Rearview reads the session transcripts it saves in `~/.claude/projects/`.
- **Git**, with your project in a Git repository.

## Install

1. **Install Obsidian.** Download it from [obsidian.md](https://obsidian.md), open it, and create a vault (any folder works) or open one you have.
2. **Get Rearview.** Download this repository as a ZIP from GitHub and unzip it, or clone it:

   ```bash
   git clone https://github.com/fivestone14/rearview.git
   ```

3. **Copy the plugin into your vault.** Make a folder `.obsidian/plugins/rearview/` inside your vault and copy the three files from the repository's `obsidian/` folder into it: `main.js`, `manifest.json` and `styles.css`. For example, on macOS or Linux, from inside the repository:

   ```bash
   mkdir -p "/path/to/your/vault/.obsidian/plugins/rearview" && cp obsidian/main.js obsidian/manifest.json obsidian/styles.css "/path/to/your/vault/.obsidian/plugins/rearview/"
   ```

   The `.obsidian` folder is hidden; in Finder press Cmd+Shift+. to show it.
4. **Turn it on.** In Obsidian open **Settings › Community plugins**, turn off **Restricted mode** if it is on, then switch on **Rearview** in the list of installed plugins.

To update Rearview later, copy the three files again and restart Obsidian.

## Use it during a review

1. **Open Rearview.** Click the eye icon in the left ribbon, or run **Rearview: Open Rearview** from the command palette (Cmd/Ctrl+P).
2. **Add your project.** Click **+** beside *Projects* and choose the project folder. Rearview checks the connection step by step: the folder, Git, the repository, the branch and last commit, the GitHub remote and whether it answers, and how far the branch is ahead or behind. A folder that is not in a Git repository is refused with the fix to make.
3. **Work in Claude Code as usual.** Each prompt you send appears under *Turns* in the left sidebar, newest first, and opens in the main tab. Rearview comes forward by itself when a new turn starts (switch this off in its settings).
4. **Review the turn.**
   - Read **Code** top to bottom; the Why notes explain the lines that need it.
   - Open **Map** to see what the change touches beyond the files it edited.
   - Use **Trace** on any name you want to follow.
   - Check **Check work** for anything partly done or missed, and **Reasoning** for shortcuts or changes nobody asked for.
5. **Steer.** In the right sidebar, write what Claude should do instead and press **Send to Claude**.
6. **Look at Git.** Under *Git*, open *Uncommitted changes* for everything changed since the last commit, including edits made by shell commands, or any recent commit.

## Reviews and Steer today

The *Why* notes, **Check work**, **Reasoning** and **Steer** come from Rearview's companion Claude Code plugin, the `hooks/` folder in this repository. It reviews each turn with a model call through your Claude Code session and delivers steers into it. Without it, Rearview still shows every turn, its diffs, Map, Trace and Git, and marks turns *not reviewed*. Reviews and steering that run from Obsidian alone are being built next.

To install the companion plugin, from the cloned repository:

```bash
claude plugin marketplace add /path/to/rearview
```

```bash
claude plugin install rearview@rearview
```

## Privacy and security

- **Everything stays on your computer.** Rearview reads Claude Code's transcripts and your project's files, and runs `git` in the project. Its only network use is the connection check, which asks your Git remote (for example GitHub) for its branches.
- **Secret-looking files are never shown.** `.env` files, private keys, credential and secrets files, Terraform state and similar names appear by name only, in turns, Git changes, Trace and the Map.
- **No command can be smuggled in.** `git` runs with an argument list, never through a shell, and Trace only searches plain names.
- **A steer is sent only by you.** Steers go to the Claude Code session only when they carry a random code that session made when it started, so a file that came with a cloned project cannot send anything.

## Limits

- **Edits made with shell commands** leave no diff in Claude Code's transcripts, so they do not appear under their turn. They do appear in the project's Git section.
- **The newest sessions are read.** Rearview reads a project's twelve most recent Claude Code sessions and shows their latest sixty turns.
- **Map and Trace are text search.** Imports are understood for relative JavaScript/TypeScript and Python imports; Trace uses `git grep`.
- **Subagents** run inside a turn and are not shown as turns of their own.

## Development

The Obsidian plugin is plain JavaScript in `obsidian/`, with no build step. The companion Claude Code plugin is checked and tested with:

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

## License

MIT. See [LICENSE](LICENSE).
