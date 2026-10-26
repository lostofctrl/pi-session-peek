# Changelog

## Unreleased

- Right-click a session (or press `Ctrl+Enter`) to open a context menu: open, fork, rename, pin / unpin, copy the file path, delete. The menu opens at the pointer and flips up / left when the bottom or right edge is close, so it always stays on screen inside the list pane. `↑` `↓` pick an item, `Enter` runs it, `Esc` or any other key closes; clicking an item runs it, clicking outside closes without running anything.
- Pin a session from the list with `Ctrl+W` or the menu. It writes the same `pi-web:pin` record Pi Web's `/pin` uses, so the state is shared both ways. Pinned sessions show `📌` in the age column, `✅` when pinned and finished and `📎` when pinned but aborted, so the status icon is not lost. Unpinning is instant, and a failed write leaves the session unchanged with a hint.
- `Ctrl+Y` copies the selected session's full file path to the clipboard.
- The preview header now shows the first and latest user prompt, so you can tell what a session is about without scrolling. The latest line is skipped when the session only has one prompt.
- The list shows relative ages (`now`, `2h`, `3d`, `1w`, `4mo`, `2y`) instead of fixed timestamps, plus a status icon: `✓` when the last reply finished and `⏹` when it was aborted or failed. Pinned rows swap in `📌` / `✅` / `📎` instead. Unfinished tails (tools still running, or the last message is yours) get no icon. Sessions are now sorted by last prompt; `Alt+S` switches to creation time, and the age column follows the chosen order.
- Search: `draft:true` / `draft:false` filter Pi Web drafts (a `draft-session` marker with no assistant reply after it; a legacy `Draft: …` name with no reply counts too). `Alt+D` toggles a drafts-only view below the query, the same way `Alt+P` does for pins.
- The header is now a row of four switches — scope, sort, pinned, drafts — and each is clickable, not just the scope label. The `📌 pinned` badge became the `pinned: only` switch value.

- Search: `pin:true` / `pin:false` filter by Pi Web's `/pin` state, read from the last `pi-web:pin` record in the session file; sessions never pinned count as unpinned. Negation works like other filters (`-pin:true`), and the state shows up as soon as the session is parsed. `Alt+P` toggles a pinned-only view without editing the query; the header switch shows `pinned: only` while it is on.
- Local performance customization: `/peek` now paints the list immediately from file metadata and parses sessions in the background, so opening no longer waits for the whole history. Placeholder rows show `Loading session…` and are replaced in batched updates without moving the selection; the picker is fully searchable as soon as files are parsed, and all history is still loaded. Plus: reuse per-picker list body analysis across repaints, cache unchanged empty parses by mtime and size, and parse JSONL without a whole-file line array. Search semantics and full-history indexing are unchanged.

## 0.5.2

- Wheel over the list now scrolls the list like a scrollbar instead of moving the selection. The selection stays where it is and comes back into view on `↑` / `↓`, a click, a new filter or a delete.
- Search: plain terms no longer match the working directory, only the conversation and the session name. With the current-directory scope every session shares the same path prefix, so a word from the path used to match all of them. Use `dir:` (or `cwd:`) to search paths.
- Internal: the picker component is split into `preview`, `list` and `drag-select` modules, escape-sequence helpers are consolidated in `ansi.ts`, and the theme is typed against pi's `Theme`. No behaviour change.

## 0.5.1

- Terminal escape sequences and control characters in message text, tool arguments and session names are stripped when parsing, so a pasted colour dump or an OSC sequence in a reply can no longer break the preview layout or reach the terminal.
- While a delete or rename is still running, `Ctrl+D`, `Ctrl+R`, `Enter`, `Ctrl+O` and double-click are ignored, so the same file cannot be deleted twice or resumed mid-delete.
- Delete: if a trash command times out but the file is already gone, the result is reported as "moved to trash" instead of falling through to a permanent delete.
- The scan follows the session directory pi is actually using (`--session-dir`, `$PI_CODING_AGENT_SESSION_DIR` or `sessionDir` in settings), and forks are written there too. With the default layout all projects are still listed.
- The parse cache is keyed on file size as well as mtime, so two quick writes within the same timestamp tick no longer serve stale content.
- Rename strips newlines from the new name, matching pi's own `/name`, so the appended record always stays on one line.

## 0.5.0

- Mouse support in both panes. Click a session to select it, double-click to resume, wheel over the list to move the selection, wheel over the preview to scroll it (`Alt` for five times faster), click the scope label to toggle it, click the search box or rename line to move the cursor. Pi only enables mouse reporting in fullscreen mode, so in the regular mode the picker turns it on itself while open and locates itself on screen with a cursor position query; the terminal's own text selection is unavailable meanwhile (usually `Shift` restores it). `PI_SESSION_PEEK_MOUSE=0` disables it.
- Drag to select text inside one pane. The selection never crosses the divider: dragging from the list into the preview, or past either edge, keeps selecting the pane where the drag started, and lines wrap at that pane's width. Dragging below or above the preview scrolls it. Nothing is copied on release; `Ctrl+C` copies the selection (and closes the picker as before when there is none), a click anywhere clears it.

## 0.4.1

- `Ctrl+T` shows tool calls in the preview: one dim line per call with the tool name and its main argument (command, path, URL, query…), placed under the reply that made it. Off by default. Tool results are still not stored, and the tool lines are never searched or highlighted.
- Assistant turns that only call tools (no text) are now kept when parsing, so with `Ctrl+T` on the preview no longer jumps from "let me check" straight to the conclusion. With it off they are skipped as before.

## 0.4.0

- Search syntax: `"exact phrase"` (whitespace inside the quotes matches any whitespace, including line breaks), `a|b` for either, `-word` to exclude, `name:` / `dir:` (`cwd:`) / `user:` / `ai:` (`assistant:`) to limit a term to one field, and `/regex/` for JavaScript regular expressions. Prefixes stack (`-user:"not now"`), quotes escape everything else, and an invalid regex falls back to plain text.
- The preview highlights and counts only positive terms, and `user:` / `ai:` terms only inside messages of that role. `name:` / `dir:` terms never touch the conversation.
- Lines containing a character whose lowercase form has a different length (for example `İ`) are now highlighted too. Before, the whole line was skipped.

## 0.3.1

- `scanSessions` is now async: directory walking and file reads go through `fs/promises` with bounded concurrency, so opening `/peek` with hundreds of sessions no longer blocks the TUI.
- Sessions no longer keep a second, lowercased copy of their full text for searching. Keyword filtering runs case-insensitive regexes over the messages directly, which roughly halves memory per cached session and is faster than the old `toLowerCase().includes()` scan.

## 0.3.0

- Ctrl+D now prefers the system trash on every platform instead of only the `trash` CLI: Windows Recycle Bin via PowerShell, Finder on macOS, `gio trash` / `trash-put` on Linux. The file is deleted permanently only when none of them works, and the notification says which one happened.

## 0.2.1

- Ctrl+N / Ctrl+P now jump between hit lines instead of hit messages. Several hits inside one long reply used to collapse into a single stop, so the preview appeared not to move. Hits already on screen are skipped, and the top-right corner shows the current hit as `hit k/n`.

## 0.2.0

- The preview renders messages with pi's own Markdown renderer: headings, bold, inline code, syntax-highlighted code blocks, tables with borders and cell wrapping, lists, quotes and links now look the same as in the main transcript.
- Keyword highlighting is applied on top of the rendered lines, so it no longer breaks links or code blocks. A keyword that is split across a wrapped line is not highlighted at that spot; hit counting and Ctrl+N / Ctrl+P are unaffected.

## 0.1.0

First release.

- Two-pane picker: session list on the left, full conversation preview on the right.
- Live filtering by conversation text, session name and working directory. Space-separated keywords must all match; `@7d`, `@24h`, `@2w`, `@1m` limit results to recently active sessions.
- Keyword highlighting, hit snippets in the list, Ctrl+N / Ctrl+P to jump between hits.
- Enter resumes, Ctrl+O forks, Ctrl+R renames, Ctrl+D deletes (moves to trash when the `trash` CLI is available).
- Tab toggles between the current directory tree and all projects.
- `/peek [keyword]` command, `--rp` and `--peek=<keyword>` startup flags.
- Chinese and English interface, following the system locale. Override with `PI_SESSION_PEEK_LANG=zh|en`.
