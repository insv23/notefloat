# Notefloat

A floating notes panel for macOS. Press Option-V anywhere and the panel appears
over whatever you are doing; press Esc and it is gone again. It holds short
notes with todos, pasted pictures and several blocks each, and it keeps every
note as a plain text file you can open with any editor.

## Why it exists

Notes you jot down mid-task should not cost a window switch. Notefloat is one
keystroke away, takes the text, the todo and the screenshot you just copied, and
gets out of the way. Nothing is filed into a database: the notes are files in a
directory, the pictures are files beside them, and the panel is only a view of
that directory.

## What it does

- **Summon and dismiss.** A global shortcut, Option-V by default and changeable
  in Settings, shows and hides the panel from any app. Esc hides it, and the
  close button and Command-W do too.
- **Todos.** Command-L turns the line under the caret into a todo and back. The
  checkbox belongs to that line alone, and a finished todo dims.
- **Pictures.** Paste a picture anywhere in a note and it sits in place among
  the lines. Enter writes under a focused picture, Shift-Enter over it, and
  Backspace removes it.
- **Blocks.** One note holds several blocks with a hairline between them.
  Option-Up and Option-Down move a block, caret included.
- **Folders and pinned notes.** The sidebar groups notes into folders, keeps
  pinned notes at the top, and moves notes and folders by dragging.
- **Plain text.** Every note is a `.txt` file: a todo line is prefixed `- [ ] `,
  a picture is a line naming its file, and blocks are separated by a line
  holding `∞∞∞`. The editor never shows the separator.
- **Local only.** No account, no sync, no network. Notes live in
  `~/Library/Application Support/Notefloat/` unless you point the data directory
  somewhere else.
- **Portable.** Pictures are stored as `images/<sha256>.<ext>`, relative to the
  data directory, so moving the notes to another directory or another Mac
  carries the pictures along.
- **Keyboard first.** Command-N new note, Command-Shift-N new folder,
  Command-P pin, Command-B sidebar, Command-comma settings. Every shortcut is
  rebindable, and each button shows the key it answers to.
- **Tidy by itself.** A daily sweep moves pictures that no note has referred to
  for seven days to the Trash.

Settings hold the shortcuts, the panel opacity, the data directory and whether
the app opens at login.

## Development

macOS only, with Go, Bun and the MyGo toolchain installed. One instance at a
time:

    bun run dev

That starts Vite and launches the dev app. Go: `go vet ./...`. Frontend:
`bun run typecheck`. See `AGENTS.md` for the file layout and the rules around
the dev session.
