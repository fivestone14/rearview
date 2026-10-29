# Rearview

An Obsidian plugin for reviewing what an AI coding agent changed, built to be easier to follow than reading changes in an IDE.

While Claude Code works on your project, Rearview shows what changed since your last commit, file by file in the order the files build on each other, with what you asked for, how the files connect, and what each change does to the app. A review by the model of your choice adds what Claude did in each file and why, whether your request was fully done, and Claude's reasoning rebuilt from its work. Guardrails and a message box let you guide Claude from the same view. Everything sits in one Obsidian window, next to your notes.

## What to expect

- **Your changes, not a history.** Each project in the left sidebar shows its uncommitted changes and last commits, refreshed every few seconds. Rearview matches them to the Claude Code requests that made them (in the desktop app, the terminal or VS Code), through Claude's edits and the shell commands it ran, so there is nothing to import.
- **By request.** The main tab opens on the conversation, newest request first. *At a glance* gives the counts and a fit meter. Changes Claude made on its own come first, under *Not from anything you asked*. Each request shows what it meant and the changes it led to, with anything that *goes further* than you asked on top and the matching changes folded into one line. Open a change for its Changed / Why, *Ask Claude about this*, or *See the code ›*. Tick each change as you review it; a request folds itself once everything in it is ticked.
- **By file.** The same changes as a table of files, in the order they build on each other, with each file's status and fit. Open a file for *What Claude did*, then each change with its Changed / Why / Fits? lines and its code right underneath, so you can check the code while reading the why.
- **How the files connect.** The right sidebar lists every file around the change in flow order, with lines from the chosen file to what it uses and what uses it. *Impact* says what each change does to the app, which files the change reaches without editing them, and where each part of your request stands.
- **Reviews with any model.** Uncommitted changes are reviewed by themselves once Claude stops for a little while, or with **Review**. Use a tool you are already signed in to (Claude Code, OpenAI Codex, Gemini CLI), a hosted API with your key (Anthropic, OpenAI, Google Gemini, OpenRouter, or any OpenAI-compatible address), or a model on your own computer (Ollama, LM Studio).
- **Trace.** Type a name in the right sidebar's *Trace* tab to see where it is defined and used, without leaving the review.
- **Guide Claude.** The bar under the changes holds your guardrails (standing instructions you switch on or off) and a message box. **Send to Claude** continues the conversation behind the changes in the background, with the guardrails that are on; **Copy** puts the message on your clipboard to paste into Claude Code.

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
3. **Work in Claude Code as usual.** The project's uncommitted changes show in the main tab as Claude edits files. Rearview comes forward by itself when you send Claude a request (switch this off in its settings).
4. **Review the changes.**
   - Read the main tab top to bottom: your request, then each file in build order. Open a request to see what it led to; *See the code ›* on any change opens it in the by-file view with its code.
   - In the right sidebar, click any file to see what it uses and what uses it, or open **Impact** to see what the changes do to the app.
   - Use **Trace** on any name you want to follow.
5. **Guide Claude.** Click **Guide Claude ›** on a flag to draft a message, or write your own in the bar under the changes, and switch on the guardrails you want. **Send to Claude** continues the conversation in the background (`claude -p --resume`): Claude can edit files, and shell commands it asks for are refused, since nobody is there to approve them. Its edits show up as the changes move. Or press **Copy** and paste the message into Claude Code yourself.
6. **Look back.** Click any of the project's last commits in the left sidebar to see it the same way.

## Choose the review model

Open **Settings › Rearview › Review model** and pick how reviews run. The setting says where your code goes for each choice.

- **Claude Code (the default).** Nothing to set up: reviews run on the Claude Code login you already use. Leave *Model* blank for your default, or type `sonnet`, `opus` or `haiku`.
- **OpenAI Codex or Gemini CLI.** Install the tool and sign in to it, then pick it. The *Status* line says whether Rearview found it.
- **An API with your key** (Anthropic, OpenAI, Google Gemini, OpenRouter). Pick it, click the *API key* box to add your key, then **Load models** and pick one. Keys are kept in Obsidian's secret storage (Obsidian 1.11.4 or newer), not in Rearview's settings file.
- **A model on your computer** (free and private). Install [Ollama](https://ollama.com), run `ollama pull qwen2.5-coder` (or any model), pick **Ollama (on this computer)**, then **Load models**. LM Studio works the same way.
- **Anything else** that speaks the OpenAI API: pick **Custom**, enter its address, a key if it needs one, and the model.

Click **Test** to check the connection. Small local models sometimes answer in a shape Rearview cannot read; the review then says so and offers **Try again**, and a larger model usually fixes it.

## Privacy and security

- **You choose where reviews go.** Rearview reads Claude Code's transcripts and your project's files, and runs `git` in the project. A review sends the changes (your requests, Claude's messages, the diffs and your guardrails) to the review model you chose: through your Claude Code, Codex or Gemini CLI login, to the API you added a key for, or to a model on your own computer, where nothing leaves it. Apart from reviews, its only network use is the connection check, which asks your Git remote for its branches.
- **Reviews run isolated.** A CLI review runs in an empty folder as a plain model call: Claude Code gets no tools, hooks or MCP servers, and saves no session.
- **Secret-looking files are never shown.** `.env` files, private keys, credential and secrets files, Terraform state and similar names appear by name only, in changes, Trace and the connections.
- **No command can be smuggled in.** `git` runs with an argument list, never through a shell, and Trace only searches plain names.
- **A message is sent only by you.** Rearview continues a conversation only when you press **Send to Claude**, and the background run can edit files but not run shell commands.

## Limits

- **Edits made with shell commands** leave no diff in Claude Code's transcripts. Rearview credits a file to Claude when one of its commands clearly writes to it (a redirect, `sed -i`, a script that writes files, a copy onto it); a command that only reads a file does not count, so an unusual write can go unnoticed.
- **The newest sessions are read.** Rearview matches changes against a project's twelve most recent Claude Code sessions.
- **Connections and Trace are text search.** Imports are understood for relative JavaScript/TypeScript and Python imports; Trace uses `git grep`.

## Development

The plugin is plain JavaScript in `obsidian/`, with no build step and no dependencies. Run its tests with:

```bash
node obsidian/test.js
```

## License

MIT. See [LICENSE](LICENSE).
