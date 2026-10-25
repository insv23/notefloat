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

- Development runs in the dev session only. Do not run `bun run build`,
  `mygo build`, `mygo dev`, or `go build` unless the user says so in this
  conversation: "build 一下", "build 并装到本地" and the like. Changing files,
  checking them, and watching the dev app is the default; a build is a request
  of its own, never a step of a fix.
- When the user does ask for a build: stop the dev session first (the pane
  above), then `bun run build`, which writes `build/Notefloat.app`. Installing
  means copying that app over the one in `/Applications` and launching it; the
  dev app must not be running beside it, because the two fight over the global
  shortcut. `go build` stays out either way: it writes a stray `notefloat`
  binary.
- Never start a second `bun run dev`: the two dev servers fight over port 5173
  and the two apps fight over the global shortcut.
- Never kill the user's dev session on your own account. A build stops it the
  documented way, in the pane above. Restarting it afterwards is a fresh
  decision, not part of the build.
- `build/` and `dist/` are build output: they appear only after a build the
  user asked for, and go away once the app is installed unless they want them
  kept. A `notefloat` binary or a `.mygo/` left behind by a stray `go build` or
  `mygo dev` is removed.

## Checking a change

- Go: `go vet ./...`
- Frontend: `bun run typecheck`

Neither leaves artifacts. The dev server reloads the page when a frontend file
changes; `mygo dev` rebuilds and relaunches the app when a Go file changes.

## Layout

`main.go` is the only Go file at the root: the panel window, the menu bar icon,
the global shortcut, and the bindings. Everything else is a package under
`internal/`:

- `internal/store` — where the notes and pictures sit (`files.go`), the folders
  and `library.json` with which note is open and where its caret was
  (`store.go`), and the search over every note's text (`search.go`).
- `internal/pictures` — pasted pictures named by their bytes, the
  `notefloat-img://` scheme that shows them, and the daily sweep that trashes
  the ones no note refers to (`sweep.go`).
- `internal/prefs` — `settings.json`, the shortcuts the user can change and the
  global one the system holds, and moving the notes to another directory.

The page is `src/`, and the editor is CodeMirror 6:

- `src/editor/model.ts` — the note's file format read as text: a line's kind, the
  blocks between `∞∞∞` lines, and a picture's path.
- `src/editor/widgets.ts` — what the text is drawn as: a todo's checkbox, a
  picture, the hairline a `∞∞∞` line becomes.
- `src/editor/commands.ts` — what the keys do, as changes to the text.
- `src/editor/index.ts` — the editor: one document, one selection, and the
  find/reveal the rest of the app calls.
- `src/paths.ts` — the one rule for a picture's path: `images/<name>` in the
  note, the whole path in a copy, a scheme URL for the page.
- `src/main.ts` — the app shell: sidebar, title, shortcuts, the editor host.
- `src/library.ts` — the library the sidebar draws: every write goes through it
  and reloads what it hands back.
- `src/save.ts` — the debounced write of the note on screen.
- `src/bindings.ts` — the page's shortcuts, matched against the settings.
- `src/sidebar.ts` — Pinned section, folders, notes, drag and drop.
- `src/search.ts` — the find bar under the title, and the dialog over the panel
  that searches every note.
- `src/settings.ts` — the settings card drawn over the panel.
- `src/shortcuts.ts` — accelerators: a key press to the stored form, and the
  stored form to how macOS draws it.
- `src/ime.ts` — the keys an input method takes for itself.

Notes live in `~/Library/Application Support/Notefloat/`: one `.txt` per note,
blocks separated by a line holding `∞∞∞`, todo lines prefixed `- [ ] `, and
pictures as lines holding `images/<sha256>.<ext>`, relative to the data
directory so that moving the notes carries their pictures along. The editor
expands them to whole paths when the user copies blocks. `library.json` holds the folders, each folder's note
order, which notes are pinned, which note was open and where its caret stood.
`settings.json` sits in
the same directory, which is also the default save location, and stays there
when the notes are moved elsewhere.

## 版本号

The version lives in `mygo.config.ts` as `version`, currently `0.1.1`. Every
commit raises the patch number by one (0.1.0, 0.1.1, 0.1.2, ...) so a built app
can be traced back to a commit. Raising the minor or major number is the user's
call, never the agent's.

## 中文文件头说明

- 新增源码文件时，在文件开头添加简明中文模块说明，让读者快速了解其宏观作用。
- 说明应涵盖主要职责、具体工作、输入输出及职责范围；按文件实际情况描述，不适用的内容无需凑齐，也不逐项复述函数实现。
- Python 使用模块 docstring，放在 `from __future__ import` 和普通 import 之前；其他语言使用合法的文件头注释，保留 shebang、编码声明等必须置顶的内容。
- 修改模块职责时，同步更新文件头说明；格式不支持注释的文件不强行插入说明。
- 新增或修改 CLI、HTTP 入口的 `.py` 文件时，参照已有同类文件，在开头模块 docstring 中添加或同步“使用”说明。CLI 应包含可执行命令示例、必要参数和输出含义；HTTP 应包含服务启动方式、请求示例和主要响应或错误说明。用法说明必须与实际实现一致。