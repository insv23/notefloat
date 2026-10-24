# notefloat

A macOS notes panel: a Go shell (MyGo) with a web frontend in WKWebView.

## Running

Development only, and only one instance of it. The user starts it in their own
terminal:

    bun run dev

That runs `mygo dev`, which starts Vite on port 5173 and launches
`.mygo/dev/darwin-arm64/Notefloat Dev.app`.

### The dev session lives in Herdr pane wM:p2

That pane is the one running `bun run dev`. Restart it in place instead of
starting another one:

    herdr pane send-keys wM:p2 ctrl+c
    # wait until nothing listens on 5173
    lsof -nP -iTCP:5173 -sTCP:LISTEN
    herdr pane run wM:p2 "bun run dev"
    herdr pane read wM:p2 --source recent-unwrapped --lines 20

Vite hot-reloads frontend changes and `mygo dev` rebuilds and relaunches the
app when a Go file changes, so a restart is only for a clean slate: a stuck
build, a stale global shortcut, or a pane that no longer answers.

- Never run `bun run build`, `mygo build`, `mygo dev`, or `go build` in this
  repository. `mygo build` writes `build/` and leaves a second copy of the app
  running next to the dev one, and `go build` writes a `notefloat` binary.
  `bun run typecheck` only needs the TypeScript compiler.
- Never start a second `bun run dev`: the two dev servers fight over port 5173
  and the two apps fight over the global shortcut.
- Never install or launch the built app. This is development only.
- Never kill the user's dev session unasked. Restart it in the pane above, or
  ask them to.
- If `build/`, `dist/` or a `notefloat` binary appears, delete it.

## Checking a change

- Go: `go vet ./...`
- Frontend: `bun run typecheck`

Neither leaves artifacts. The dev server reloads the page when a frontend file
changes; `mygo dev` rebuilds and relaunches the app when a Go file changes.

## Layout

- `main.go` — panel window, global shortcut, menu bar icon, the bindings.
- `settings.go` — `settings.json` (shortcuts, login item, data directory,
  opacity), the global shortcut registration, copying the notes to a new
  directory.
- `store.go` — notes as text files, folders and pinned notes in `library.json`,
  pictures under `images/`, the `notefloat-img://` scheme that shows them, and
  the search over every note.
- `gc.go` — the daily sweep that moves pictures no note refers to to the Trash
  after a grace period.
- `src/editor.ts` — the note editor: blocks of lines, a line being text or a
  todo, pictures in place. A picture can be focused (click or the arrows);
  Enter adds a line under it, Shift-Enter over it, Backspace removes it.
- `src/main.ts` — the app shell: sidebar, title, shortcuts, the editor host.
- `src/sidebar.ts` — Pinned section, folders, notes, drag and drop.
- `src/search.ts` — the find bar under the title, which marks the word it finds
  in the open note, and the dialog over the panel that searches every note and
  lists the matching lines with a line of context on either side.
- `src/settings.ts` — the settings card drawn over the panel.
- `src/shortcuts.ts` — accelerators: a key press to the stored form, and the
  stored form to how macOS draws it.

Notes live in `~/Library/Application Support/Notefloat/`: one `.txt` per note,
blocks separated by a line holding `∞∞∞`, todo lines prefixed `- [ ] `, and
pictures as lines holding `images/<sha256>.<ext>`, relative to the data
directory so that moving the notes carries their pictures along. The editor
expands them to whole paths when the user copies blocks. `library.json` holds the folders, each folder's note
order, which notes are pinned, and which note was open. `settings.json` sits in
the same directory, which is also the default save location, and stays there
when the notes are moved elsewhere.
