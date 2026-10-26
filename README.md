# 🔍 pi-session-peek — Find That Old Conversation and Jump Back In

[![npm](https://img.shields.io/npm/v/pi-session-peek)](https://www.npmjs.com/package/pi-session-peek) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

[中文说明](https://github.com/Jeffropz/pi-session-peek/blob/main/README.zh-CN.md)

Search your [pi](https://pi.dev) session history by what was actually said, read the whole conversation in a side pane, then resume it or fork it.

![pi-session-peek screenshot](https://raw.githubusercontent.com/Jeffropz/pi-session-peek/main/docs/screenshot.png)

## ✨ Features

- Opens a two-pane picker with `/peek` or `/peek <keyword>`: sessions on the left, the full conversation on the right.
- Renders the conversation with pi's own Markdown renderer, so headings, code blocks with syntax highlighting, tables and lists look the same as in the main transcript.
- Filters as you type across conversation text and session name. The working directory is searched only with an explicit `dir:`, so a word from a project path does not match every session in that project. Tool call arguments and results are excluded from the search, so a keyword only matches sessions that actually discussed it.
- Requires every space-separated keyword to match, and shows a snippet around the first hit in the list.
- Understands `"exact phrases"`, `either|or`, `-exclude`, `name:` / `dir:` / `user:` / `ai:` prefixes, `/regex/`, `pin:true` / `pin:false` for Pi Web's `/pin` state, and `draft:true` / `draft:false` for its drafts. `Alt+P`, `Alt+D` and `Alt+S` toggle pinned-only, drafts-only and the sort order without touching the typed query.
- Limits results to recently active sessions with `@7d`, `@24h`, `@2w` or `@1m`.
- Shows each session's age as relative time (`now`, `2h`, `3d`, `1w`) instead of a fixed timestamp, plus a status icon: `✓` when the last reply finished, `⏹` when it was aborted or failed. Sessions with an unfinished turn (tools still running, or a question waiting for you) get no icon. Pinned rows use `📌` (still running), `✅` (pinned and finished) and `📎` (pinned but aborted).
- Marks sessions written in the last 10 minutes with a green `●` after the directory, so a session another Pi is working in right now stands out before you resume it. It is a recency hint, not a record of which Pi has a session open: the marker reads the file's mtime, and nothing on disk says who holds a session open. The mtime is the one read when `/peek` opened, and the dot is recalculated on each repaint, so a session that starts moving afterwards is marked the next time you open the picker. The session you run `/peek` from is not listed.
- Right-click a session for a context menu — open, fork, rename, pin / unpin, copy the file path, delete — or press `Ctrl+Enter` to open the same menu for the selected row. `↑` `↓` pick an item, `Enter` runs it, `Esc` closes.
- Sorts newest first by last prompt; `Alt+S` switches to creation time. The header shows which of the two is active.
- Highlights every hit in the preview and jumps between them with `Ctrl+N` / `Ctrl+P`.
- Shows what the assistant actually did with `Ctrl+T`: one dim line per tool call (`⚙ bash  git status`, `⚙ edit  src/query.ts`) under the reply that made it. Off by default.
- Resumes with `Enter`, forks into a new session with `Ctrl+O`, renames with `Ctrl+R`, deletes with `Ctrl+D`, pins with `Ctrl+W` (the same `pi-web:pin` record Pi Web's `/pin` writes) and copies the file path with `Ctrl+Y`.
- The preview header shows the first and latest user prompt, so you can tell what a session is about at a glance.
- Shows a skill invocation as `/skill:name` instead of the whole skill body, both in the preview and in those first / latest prompt lines; anything you typed after the skill is kept. Pi wraps the skill's entire SKILL.md into the user message, so without this a single `/skill:tdd` would fill the preview.
- Toggles between the current directory tree and all projects with `Tab`.
- Starts straight into the picker with `pi --rp` or `pi --peek=<keyword>`.
- Parses each session file once and caches it by mtime, so reopening is instant.

## Local performance customization

This checkout retains the MIT-licensed upstream source from [Jeffropz/pi-session-peek](https://github.com/Jeffropz/pi-session-peek). It is a local customization, not a published GitHub fork.

- `/peek` opens from file metadata alone: one `stat` per session file, no parsing. Rows appear right away, newest first, with `Loading session…` in the preview until their file is read.
- Parsing runs in the background in small batches (8 readers, flush every 24 files or 120 ms) and merges into the visible list without moving the selection or resetting an unchanged preview. Sessions without message text are removed when their parse comes back empty, and a failed read leaves the row as a placeholder instead of aborting the picker.
- On a 3377-file (2.6 GB) real session directory, a fresh process lists and renders the picker in about 0.4 s; before this change the same directory took about 15.6 s before the first frame. Full background parsing still takes ~18 s, but the picker stays usable while it runs.
- List hit counts and snippets are reused across unchanged-query repaints and selection changes. Each picker keeps only one query/width revision per session; query edits and refiltering invalidate the cache.
- Unchanged empty or malformed sessions are cached by mtime and size too; failed filesystem reads are retried.
- JSONL parsing walks line boundaries without allocating a whole-file line array. Files are still read in full, and all history remains searchable.

For this installation, replace `npm:pi-session-peek` in the `packages` list of `~/.pi/agent/settings.json` with `../../pi-plugin/pi-session-peek`, then run `/reload`. Do not load both copies. Restore the npm entry to undo activation.

Verified with `npx tsc --noEmit` and `npm test` (163 tests), the benchmark above, and an isolated Pi 1.4.0 TUI session (`PI_CODING_AGENT_DIR` sandbox with a 300-file copy of the real session directory): `/peek` showed the picker after 63–86 ms, typing a filter updated it, and `Esc` returned to the editor. The background load is still CPU-bound on very large files: a single large JSONL parse can block the event loop for roughly 0.2 s once, so a keystroke at that moment can feel slightly delayed.

## 📦 Install

```bash
pi install npm:pi-session-peek
```

Try it without installing permanently:

```bash
pi -e npm:pi-session-peek
```

Install from GitHub instead of npm:

```bash
pi install git:github.com/Jeffropz/pi-session-peek
```

Pi extensions run with the Pi process's user permissions, so install only trusted packages.

## 🚀 Quick start

In TUI mode, run `/peek` and start typing. Press `Enter` on a session to continue it, or `Ctrl+O` to continue in a fresh fork and leave the original untouched.

## 💬 Commands

| Command | Purpose |
| --- | --- |
| `/peek` | Open the picker. The previous keyword is remembered for the process. |
| `/peek <keyword>` | Open the picker with the keyword filled in. |
| `pi --rp` | Start pi and open the picker. Takes no argument. |
| `pi --peek=<keyword>` | Start pi and open the picker with the keyword filled in. `--peek` requires a value. |

## ⌨️ Keys

| Key | Action |
| --- | --- |
| type | Filter. Space-separated words must all match; see [Search syntax](#-search-syntax) for phrases, `-exclude`, prefixes, regex and `@7d`. |
| `Tab` | Current directory tree ↔ all projects |
| `↑` `↓` | Select session |
| `PgUp` `PgDn` | Scroll preview by a page |
| `Ctrl+U` `Ctrl+F` | Scroll preview by half a page |
| `Shift+↑` `Shift+↓` | Scroll preview by three lines |
| `Ctrl+N` `Ctrl+P` | Next / previous hit line outside the current view; the top-right corner shows `hit k/n` |
| `Ctrl+T` | Show / hide tool calls in the preview. Each call is one line with the tool name and its main argument (command, path, URL, query). Results are never shown. |
| `Alt+P` | Show only sessions pinned in Pi Web with `/pin`; press again to show all. Stacks with the typed query. |
| `Alt+D` | Show only Pi Web drafts (a `draft-session` marker the assistant never answered); press again to show all. Stacks with the typed query. |
| `Alt+S` | Sort by last prompt (default) or by creation time. The list order and the age column both follow it. |
| `Enter` | Resume the session |
| `Ctrl+O` | Fork the session and open the fork |
| `Ctrl+R` | Rename. Writes the same `session_info` entry as `/name`. |
| `Ctrl+W` | Pin / unpin the session. Writes the same `pi-web:pin` record as Pi Web's `/pin`, so the state is shared with Pi Web's session list. |
| `Ctrl+Y` | Copy the selected session's full file path to the clipboard. |
| `Ctrl+Enter` | Open the session menu for the selected row (the keyboard equivalent of right-click). |
| `Ctrl+D` | Delete, confirmed with `y` or `Enter`. Moves the file to the system trash whenever one is available (`trash` CLI, then the Windows Recycle Bin via PowerShell, Finder on macOS, `gio trash` / `trash-put` on Linux). Deletes permanently only if none of those work. |
| `Esc` `Ctrl+C` | Close |

## 🖱️ Mouse

| Action | Effect |
| --- | --- |
| Click a session in the list | Select it |
| Double-click a session | Resume it (same as `Enter`) |
| Right-click a session | Open its context menu at the pointer: open, fork, rename, pin / unpin, copy path, delete. The menu opens on a plain press-and-release; dragging past a few cells first cancels it. Near the bottom or right edge it flips up / left to stay on screen and inside the list pane. Right-clicking outside the list does nothing. |
| Click a menu item | Run that action. Clicking outside the menu closes it without running anything. |
| Wheel over the list | Scroll the list like a scrollbar; the selection stays where it is. `↑` `↓`, a click or a new filter bring it back into view. |
| Wheel over the preview | Scroll the preview three lines per notch (`Alt` for five times faster) |
| Click a switch in the header | Toggle the scope, the sort order, pinned-only or drafts-only (same as `Tab`, `Alt+S`, `Alt+P`, `Alt+D`) |
| Click the search box or the rename line | Move the cursor |
| Drag inside a pane | Select text in that pane only. Dragging across the divider or past the edge keeps the selection in the pane where it started, and lines wrap within that pane. |
| `Ctrl+C` with a selection | Copy it to the clipboard. Nothing is copied on release. Without a selection `Ctrl+C` closes as before; a click anywhere clears the selection. |

Mouse reporting is switched on only while the picker is open and switched off when it closes, so the rest of pi is unaffected. While it is on, the terminal's own text selection and scrollback are unavailable; most terminals give them back while `Shift` is held, but that selection is the terminal's and spans both panes. Set `PI_SESSION_PEEK_MOUSE=0` to keep the mouse off. In pi's fullscreen mode the picker uses pi's own mouse handling and the variable is ignored.

## 🔎 Search syntax

The filter is case-insensitive and matches anywhere in the text. Whitespace separates terms, and every term must be satisfied.

| Input | Meaning |
| --- | --- |
| `token undefined` | Sessions containing both `token` and `undefined`, in any order and any message |
| `"token undefined"` | The exact phrase. Whitespace inside the quotes matches any run of whitespace, including a line break. |
| `vue\|react` | Sessions containing `vue` or `react` |
| `-draft` | Sessions that do not contain `draft` in any message or in the session name |
| `name:auth` | Session name only. `dir:` or `cwd:` for the working directory. |
| `user:deploy` | Only the messages you wrote. `ai:` or `assistant:` for the replies. |
| `/\bfoo\d+\b/` | JavaScript regular expression, case-insensitive, `^` and `$` match line boundaries. Use `\s` instead of a space. |
| `@7d` | Sessions active in the last 7 days. Units: `h`, `d`, `w`, `m` (30 days). |
| `pin:true` | Only sessions pinned in Pi Web with `/pin`. `pin:false` (or `-pin:true`) shows unpinned sessions; a session that was never pinned counts as unpinned. `Alt+P` toggles pinned-only as a separate filter that stacks with the query. |
| `draft:true` | Only Pi Web drafts: a session with a `draft-session` marker that the assistant never answered. `draft:false` (or `-draft:true`) shows the rest. `Alt+D` toggles drafts-only as a separate filter that stacks with the query. |
| `-user:"not now" ai:/todo\|fixme/ @2w` | Prefixes stack, and everything combines |

Quotes are the escape hatch: `"-foo"`, `"a|b"`, `"name:x"`, `"pin:true"` and `"/x/"` search for those characters literally. A regex that fails to compile is searched as plain text. Only positive text terms are highlighted in the preview; `name:` / `dir:` and `pin:` terms never touch the conversation, so `name:auth` alone shows the full conversation with no highlights.

The pin state is read from Pi Web's `pi-web:pin` records in the session file; the last record wins, and invalid or missing records count as unpinned. The draft state comes from `draft-session` records: a session stays a draft until an assistant message follows the marker, and an old session named `Draft: …` with no assistant reply counts as a draft too. The search index holds user and assistant messages and the session name. The working directory is matched only by `dir:` / `cwd:` terms: with the current-directory scope every session shares the same path prefix, so a plain word from the path would match all of them. The index does not hold tool call arguments or tool results, and the tool lines shown by `Ctrl+T` are never matched or highlighted.

## 🌐 Language

The interface follows your system language: Chinese on `zh-*` locales, English everywhere else. Detection order is `PI_SESSION_PEEK_LANG`, then `LC_ALL` / `LC_MESSAGES` / `LANG`, then the OS locale.

Force a language:

```bash
PI_SESSION_PEEK_LANG=en pi
PI_SESSION_PEEK_LANG=zh pi
```

On Windows PowerShell: `$env:PI_SESSION_PEEK_LANG = "en"` before starting pi. The language is read once when the extension loads, so change it before starting pi or run `/reload`.

## 🚧 Limitations

- TUI mode only.
- The mouse needs a terminal that supports SGR mouse reporting and the cursor position report (`CSI 6 n`). Windows Terminal, iTerm2, kitty, WezTerm, Alacritty, GNOME Terminal and VS Code all do; the legacy Windows console does not.
- The preview shows the last 500 messages of very long sessions. Hits in earlier messages are still counted and announced.
- `pi --peek` without a value is rejected by pi at startup. Use `pi --rp` to open without a keyword.
- With the default layout every project under `~/.pi/agent/sessions` (or `$PI_CODING_AGENT_DIR/sessions`) is scanned. If pi runs with a custom session directory (`--session-dir`, `$PI_CODING_AGENT_SESSION_DIR` or `sessionDir` in settings), only that directory is scanned and forks are written there.

## 🗂️ Package layout

```text
pi-session-peek/
├── index.ts                 # Registers /peek and the startup flags, injects delete / rename / fork / copy
├── src/
│   ├── peek-component.ts    # The two-pane component: state, key and mouse routing, header / footer, pane composition
│   ├── preview.ts           # Right pane: preview lines and hit lines for a session, initial offset, Ctrl+N/P targets
│   ├── list.ts              # Left pane: two rows per session, viewport following
│   ├── menu.ts              # Session context menu: box width, placement, drawing
│   ├── drag-select.ts       # Drag-selection state machine: press / drag / release / auto-scroll
│   ├── selection.ts         # Selection geometry: ranges, inverse-video highlight, text extraction
│   ├── layout.ts            # Pane widths and body height
│   ├── sessions.ts          # Scans and parses session JSONL, rename / pin / delete helpers, first and latest prompt
│   ├── skill.ts             # Recognises pi's <skill> wrapper in a user message, shortens it to /skill:name
│   ├── query.ts             # Query parsing, matching, highlighting, hit snippets
│   ├── mouse.ts             # Mouse reporting for pi's regular (non-fullscreen) mode
│   ├── ansi.ts              # Escape-sequence tokenising, SGR tracking, input sanitising
│   ├── theme.ts             # The subset of pi's Theme the picker uses
│   ├── i18n.ts              # Chinese / English UI strings and locale detection
│   └── text.ts              # Path, time and width helpers
├── scripts/screenshot.mjs   # Optional: renders a synthetic screenshot from component output
└── test/                    # node:test suites
```

## 🛠️ Development

```bash
npm install
npm test               # node:test via tsx
npm run typecheck      # tsc --noEmit
npm run screenshot     # optional: overwrite docs/screenshot.png with a synthetic render (needs Chrome)
```

To load a local checkout, add its path under `extensions` in `~/.pi/agent/settings.json` or drop the folder into `~/.pi/agent/extensions/`, then `/reload`.

### Releasing

Every push to `main` and every pull request runs `npm run check` on Ubuntu and Windows (`.github/workflows/ci.yml`). Pushing a `vX.Y.Z` tag runs `.github/workflows/release.yml`, which checks that the tag matches `package.json`, runs the checks again, publishes to npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers/) (no token needed, provenance attached automatically) and creates a GitHub Release from the matching `CHANGELOG.md` section.

One-time setup on npmjs.com: package settings → Trusted Publisher → GitHub Actions, with owner `Jeffropz`, repository `pi-session-peek`, workflow filename `release.yml`.

To cut a release:

```bash
# 1. write the release notes under "## Unreleased" in CHANGELOG.md and commit them
#    (npm version refuses to run with uncommitted changes to tracked files)
# 2. bump the version (patch / minor / major)
npm version patch
# 3. push the commit together with the tag; CI does the rest
git push --follow-tags
```

`npm version` first checks that the working tree is clean and stops with `Git working directory not clean.` otherwise, so everything, including `CHANGELOG.md`, has to be committed before the bump. Untracked files are fine. It then runs the hooks declared in `package.json`: `preversion` checks that `CHANGELOG.md` has a non-empty `## Unreleased` section and runs `npm run check`, aborting the bump before anything is touched if either fails; `version` runs `scripts/release-changelog.mjs`, which renames `## Unreleased` to the new version and stages the file. npm then commits `package.json`, the lockfile and `CHANGELOG.md` as `chore: release X.Y.Z` (message set in `.npmrc`) and tags it `vX.Y.Z`.

## 🔗 Friend links

- [LinuxDo — sincere, friendly, united, professional](https://linux.do)

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
