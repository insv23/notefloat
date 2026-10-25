# notefloat

A macOS notes panel: a Go shell (MyGo) with a web frontend in WKWebView.

## Running

Development only, and only one instance of it. The user starts it in their own
terminal:

    bun run dev

That runs `mygo dev`, which starts Vite on the dev port, 18731, and launches
`.mygo/dev/darwin-arm64/Notefloat Dev.app`. The port lives in `dev.config.ts` as
`DEV_PORT`, read by both `vite.config.ts` and `mygo.config.ts`: it is deliberately
an uncommon number, because 5173 is what every other project's dev server reaches
for when its author forgets to change it.

### The dev session lives in a Herdr pane this file does not name

Find it rather than assume an ID, because the layout changes between sessions:

    herdr pane list --workspace "$HERDR_WORKSPACE_ID"
    lsof -nP -iTCP:18731 -sTCP:LISTEN

The dev server is the pane serving port 18731. Read a pane to confirm before
acting on it:

    herdr pane read <pane> --source recent-unwrapped --lines 20

When no pane serves 18731, create one of your own and start the server there,
instead of taking over the pane the agent was started in:

    herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd "$PWD" --label dev
    herdr pane run <returned-pane> "bun run dev"

Once a pane exists, restart it in place instead of starting another one:

    herdr pane send-keys <pane> ctrl+c
    # wait until nothing listens on 18731
    herdr pane run <pane> "bun run dev"
    herdr pane read <pane> --source recent-unwrapped --lines 20

Vite hot-reloads frontend changes and `mygo dev` rebuilds and relaunches the
app when a Go file changes, so a restart is only for a clean slate: a stuck
build, a stale global shortcut, or a pane that no longer answers.

- Development runs in the dev session only. Do not run `bun run build`,
  `mygo build`, `mygo dev`, or `go build` unless the user says so in this
  conversation: "build 一下", "build 并装到本地" and the like. Changing files,
  checking them, and watching the dev app is the default; a build is a request
  of its own, never a step of a fix.
- When the user does ask for a build: stop the dev session first (the pane found
  above), then raise the patch number in `mygo.config.ts` and draft that version's
  section in `CHANGELOG_zh.md` — see 版本号 and 中英文档成对 — wait for the user to
  review it, translate it into `CHANGELOG.md`, and run `bun run build`, which
  writes `build/darwin-arm64/Notefloat.app`. A build is not finished until that
  app is installed: copy it over `/Applications/Notefloat.app` and launch it,
  without asking again, because a build the user asked for is one they want to
  run. The dev app must not be running beside it, because the two fight over the
  global shortcut. `go build` stays out either way: it writes a stray `notefloat`
  binary.
- Never start a second `bun run dev`: the two dev servers fight over the dev
  port and the two apps fight over the global shortcut.
- Never kill the user's dev session on your own account. A build stops it the
  documented way, in that pane. Restarting it afterwards is a fresh decision,
  not part of the build.
- `build/` and `dist/` are build output: they appear after a build the user asked
  for, and are removed once the app is installed in `/Applications`, unless the
  user wants them kept. A `notefloat` binary or a `.mygo/` left behind by a stray
  `go build` or `mygo dev` is removed.

## Checking a change

- Go: `go vet ./...`
- Frontend: `bun run typecheck`

Neither leaves artifacts. The dev server reloads the page when a frontend file
changes; `mygo dev` rebuilds and relaunches the app when a Go file changes.

## Layout

`main.go` is the only Go file at the root: the panel window, the menu bar icon,
the global shortcut, and the bindings. `dev.config.ts` at the root holds the dev
port that `vite.config.ts` and `mygo.config.ts` both read. Everything else is a
package under `internal/`:

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

## 中英文档成对

The docs come in pairs, and the Chinese half is written first:

- `README_zh.md` is the text; `README.md` is its translation.
- `CHANGELOG_zh.md` is the text; `CHANGELOG.md` is its translation.

This rule lives here and only here. Neither file of a pair says which side it is:
a reader of the repo does not need a line telling them, and the line only
becomes a lie the day it goes stale.

A doc change goes through three steps, in this order:

1. Write the change in the `_zh` file, in Chinese, holding to the points that
   matter: what changed, and what the user gets out of it. Do not draft the
   English alongside it.
2. Stop and hand the Chinese to the user for review. They read it, and often
   edit it in their editor rather than describing the change back.
3. Translate the text as it stands after their edits, not the version you wrote.
   Same sections, same order, same claims; a translation never adds a claim the
   Chinese does not make, and never drops one it does.

The English files keep the tone the rest of the repo uses. A change that touches
one half touches both, so a stale English file is a defect like a stale comment.

## 版本号

The version lives in `mygo.config.ts` as `version`, currently `0.1.1`. It rises
when the app is built, at no other time: the user tests every change against the
dev server first and asks for a build only once it looks right, so a commit on
its own leaves the number alone. At the build, the patch number goes up by one
(0.1.1, 0.1.2, ...) so a built app traces back to the commit it was built from,
without spending a version on a change that never ships. Raising the minor or
major number is the user's call, never the agent's.

The same build writes that version's section in `CHANGELOG_zh.md` first: the
version and date, then what a user notices, grouped as 新增, 变更, 修复 and 移除,
newest section first. Read it off the diff since the last version and leave out
internal work nobody can see. The user reviews that section, and `CHANGELOG.md`
receives its translation — see 中英文档成对. A build without its section leaves
the changelog claiming a version the app never had.

## 发布

A release is a build plus the same files on GitHub, in this order:

    # 1. the build and the install, as Running and 版本号 describe
    bun run build

    # 2. the asset name carries no space, so the download URL needs no escaping
    mv "build/darwin-arm64/Notefloat <version> arm64.dmg" \
       "build/darwin-arm64/Notefloat-<version>-arm64.dmg"

    # 3. the checksum names the file alone, so shasum -a 256 -c works in the
    #    directory a user downloads into
    cd build/darwin-arm64 && shasum -a 256 Notefloat-<version>-arm64.dmg > SHA256SUMS.txt

    # 4. tag the commit the build came from
    git tag v<version> && git push origin v<version>

    # 5. the release, its disk image and its checksum, with that version's
    #    changelog section as the notes
    gh release create v<version> --title "Notefloat <version>" \
      --notes "$(awk '/^## <version>/{on=1; next} /^## /{on=0} on' CHANGELOG.md)" \
      build/darwin-arm64/Notefloat-<version>-arm64.dmg \
      build/darwin-arm64/SHA256SUMS.txt

The disk image is signed ad hoc and not notarized, so macOS refuses the first
launch of a copy that came through a browser. The release notes carry the way
past it, because that is the only place a first-time installer reads:

    macOS stops the first launch: try to open it, dismiss the warning, then go to
    System Settings > Privacy & Security > Open Anyway. Or, in a terminal:
    xattr -dr com.apple.quarantine /Applications/Notefloat.app

Notarizing removes the step. An Apple Developer account plus
`macos.signingIdentity` and `macos.notarize.keychainProfile` in `mygo.config.ts`
does it; until then, the note above is not optional.

The repository is public; the first push creates it:

    gh repo create <name> --public --source=. --remote=origin --push

## 中文文件头说明

- 新增源码文件时，在文件开头添加简明中文模块说明，让读者快速了解其宏观作用。
- 说明应涵盖主要职责、具体工作、输入输出及职责范围；按文件实际情况描述，不适用的内容无需凑齐，也不逐项复述函数实现。
- 修改模块职责时，同步更新文件头说明；格式不支持注释的文件不强行插入说明。
