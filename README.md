# Rearview

An Obsidian plugin for reviewing what an AI coding agent changed, built to be easier to follow than reading changes in an IDE.

While Claude Code works on your project, Rearview shows each request you made and what came of it: every file changed, with the diff, how the changed files connect, and where a name is defined and used. A review by the model of your choice adds why each change was made, whether the request was fully done, and Claude's reasoning rebuilt from its work. Everything sits in one Obsidian window, next to your notes.

## What to expect

- **Every request is a turn.** Each prompt you type in Claude Code (in the desktop app, the terminal or VS Code) becomes a turn in Rearview, with Claude's messages, the files it read, and each edit it made. Turns appear and grow while Claude works; there is nothing to import or refresh.
- **Code.** Each changed file's diff, line by line. Under a line that needs explaining, a *Why* note says why it changed and where that reason comes from: *Claude said so*, *inferred* from the code, or *no reason found*.
- **Map.** The changed files in the middle, the files that use them on the left, and the files they use on the right, with lines for "uses". Click a changed file to jump to its diff.
- **Check work and Reasoning.** Your request split into parts marked *done*, *partly* or *missed*, and Claude's steps rebuilt with problems first (shortcuts, unrequested changes, skipped work).
- **Reviews with any model.** A turn is reviewed by itself once Claude finishes it, or with **Review** on any turn. Use a tool you are already signed in to (Claude Code, OpenAI Codex, Gemini CLI), a hosted API with your key (Anthropic, OpenAI, Google Gemini, OpenRouter, or any OpenAI-compatible address), or a model on your own computer (Ollama, LM Studio).
- **Trace.** Click **Trace** beside a Why note to see where a name is defined and used, without leaving the review.
- **Git.** Each project also lists its uncommitted changes, refreshed every few seconds, and its recent commits. Open one to see its diff and Map like a turn.
- **Steer.** Write what Claude should do instead. **Send to Claude** continues that turn's conversation in the background, and Claude's reply and changes appear as a new turn; **Copy** puts the message on your clipboard to paste into Claude Code.

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
5. **Steer.** In the right sidebar, write what Claude should do instead. **Send to Claude** continues the turn's conversation in the background (`claude -p --resume`): Claude can edit files, and shell commands it asks for are refused, since nobody is there to approve them. Its reply and changes appear as a new turn marked *steer*. If that conversation is open in Claude Code, reopen it there to see the steer. Or press **Copy** and paste the message into Claude Code yourself.
6. **Look at Git.** Under *Git*, open *Uncommitted changes* for everything changed since the last commit, including edits made by shell commands, or any recent commit.

## Choose the review model

Open **Settings › Rearview › Review model** and pick how reviews run. The setting says where your code goes for each choice.

- **Claude Code (the default).** Nothing to set up: reviews run on the Claude Code login you already use. Leave *Model* blank for your default, or type `sonnet`, `opus` or `haiku`.
- **OpenAI Codex or Gemini CLI.** Install the tool and sign in to it, then pick it. The *Status* line says whether Rearview found it.
- **An API with your key** (Anthropic, OpenAI, Google Gemini, OpenRouter). Pick it, click the *API key* box to add your key, then **Load models** and pick one. Keys are kept in Obsidian's secret storage (Obsidian 1.11.4 or newer), not in Rearview's settings file.
- **A model on your computer** (free and private). Install [Ollama](https://ollama.com), run `ollama pull qwen2.5-coder` (or any model), pick **Ollama (on this computer)**, then **Load models**. LM Studio works the same way.
- **Anything else** that speaks the OpenAI API: pick **Custom**, enter its address, a key if it needs one, and the model.

Click **Test** to check the connection. Small local models sometimes answer in a shape Rearview cannot read; the turn then says so and offers **Try again**, and a larger model usually fixes it.

## The companion Claude Code plugin

This repository also holds an earlier companion plugin for Claude Code, the `hooks/` folder, which adds a review pane inside Claude Code itself. Rearview in Obsidian no longer needs it, and it is being retired. To install it anyway, from the cloned repository:

```bash
claude plugin marketplace add /path/to/rearview
```

```bash
claude plugin install rearview@rearview
```

## Privacy and security

- **You choose where reviews go.** Rearview reads Claude Code's transcripts and your project's files, and runs `git` in the project. A review sends the turn (your request, Claude's messages and the diffs) to the review model you chose: through your Claude Code, Codex or Gemini CLI login, to the API you added a key for, or to a model on your own computer, where nothing leaves it. Apart from reviews, its only network use is the connection check, which asks your Git remote for its branches.
- **Reviews run isolated.** A CLI review runs in an empty folder as a plain model call: Claude Code gets no tools, hooks or MCP servers, and saves no session.
- **Secret-looking files are never shown.** `.env` files, private keys, credential and secrets files, Terraform state and similar names appear by name only, in turns, Git changes, Trace and the Map.
- **No command can be smuggled in.** `git` runs with an argument list, never through a shell, and Trace only searches plain names.
- **A steer is sent only by you.** Rearview continues a conversation only when you press **Send to Claude**, and the background run can edit files but not run shell commands.

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
