# Notefloat

macOS 上的一个浮动便签面板。
在任何地方按 Option-V，面板就出现在当前工作之上；再按一次 Option-V 它又消失。
记录文本、待办、粘贴进来的图片。

![Notefloat 面板：左侧是分好文件夹和置顶笔记的侧边栏，右侧是一篇带图片的笔记](resources/screenshot.jpg)

## 为什么做它

在开发过程中，经常在做 A 需求时发现了一个 B 问题，但无法立即做，所以需要写下来，但如果每一次都创建一个新的文本文件，或在一个文本文件里面手动打一个分隔符来记录这件事，感觉很慢。
因此我使用的是 [heynote](https://github.com/heyman/heynote)，它这个 block 的概念非常贴合我的心意。对于一个项目来说，我只需要创建一个文本文件，然后在里面不停地追加 block，自然形成一个待办事项的堆栈，我能依次处理。

但 heynote 有两个痛点：
1. 全局召唤和隐藏的快捷键不太灵敏；
2. 无法粘贴图片。我在开发过程中经常遇到 UI 需要小微调的 bug，当时不一定有时间来做，就需要把 UI 截图下来，粘贴，以后做的时候直接把整个图片复制交给 agent 来修复。

## 它做什么

- **唤起与收起。** 全局快捷键，默认 Option-V，可以在设置里改。
- **块。** 一篇笔记可以放多个块，块之间由一行 ∞∞∞ 隔开。
  - Command-Enter 在当前块下面加一块，Command-Shift-Enter 加在上面，Option-Enter 把当前块从光标处拆成两块。
  - Option-Up 和 Option-Down 移动整块，连光标一起；Command-Up 和 Command-Down 跳到上一块和下一块。
  - Command-A 选择整块，再按一次选择整个笔记。
  - Command-B 切换当前块的完成状态，完成状态的块整个变为灰色。
  - Command-D 折叠当前块，再按一次展开；Command-Shift-D 折叠整篇，再按一次全部展开。折叠的块按设置的高度（默认 4 排，1 到 12 可调）画成只读的阅读视图，窗口拖宽拖窄都是那么多排，跟块里有多少个文本行无关；底部有一层渐变模糊，点一下就展开，光标落在你点的位置。
  - 标题栏右上角的漏斗在「显示全部块」和「只显示没标记完成的块」之间切换。
- **待办。**
  - Command-L 把光标所在的那一行变成待办，再按一次变回普通文本。
  - Command-Shift-L 切换该行待办的完成状态。
- **图片。**
  - 在笔记的任何位置粘贴图片，会自动存储。
  - 可以复制图片的路径交给 agent 使用。
- **文件夹与置顶。**
  - 笔记和文件夹都能拖动。
  - 侧边栏的右边缘可以拖动调宽。
- **纯文本。** 每篇笔记都是一个 `.txt` 文件，块之间用一行 `∞∞∞` 隔开。
  - 图片是相对路径的文本行。
  - 块的完成状态和折叠状态也写在这条分隔线上（`∞∞∞|done`、`∞∞∞|folded`），所以标记跟着块本身走：移动、拆分、删除、撤销，或者在别的编辑器里改这篇笔记，都不会串到隔壁块上。
- **只在本地。**
  - 没有账号，没有同步，不联网。
  - 数据默认保存在 `~/Library/Application Support/Notefloat/`，可迁移到其他指定目录。
  - 图片存成 `images/<sha256>.<ext>`，相对数据目录。
- **键盘优先。**
  - Command-N 新建笔记，Command-Shift-N 新建文件夹，Command-P 置顶，Command-S 侧边栏，Command-comma 设置。
  - Command-F 在当前笔记里查找，Command-Shift-F 搜索所有笔记。
  - 每个快捷键都能自定义。
- **自己保持整洁。** 每天扫一次，把七天没被任何笔记引用的图片移到废纸篓。

设置里放着快捷键、面板透明度、折叠高度、数据目录和是否开机启动。

## 开发

macOS 12.0 或更新版本，另需 Go 1.27+ 和 Bun。开发与打包都由 [MyGo](https://mygo.egoist.dev/docs/getting-started) 驱动，配置步骤见那份文档。

把这个仓库交给 AI agent 时，可以把下面这段整块贴给它：

```text
这个仓库是一个 MyGo 应用：Go 外壳 + Vite 前端。
1. 按 https://mygo.egoist.dev/docs/getting-started 配好 MyGo，确认 go >= 1.27、bun 已安装；
2. bun install；
3. bun run dev 启动开发服务器（Vite 端口见 dev.config.ts 里的 DEV_PORT，目前 18731），它会拉起开发版 app；
4. 改前端由 Vite 热更新，改 Go 时 mygo dev 会自己重建并重启 app；
5. 查错用 go vet ./... 和 bun run typecheck。
```

打包：

```sh
bun run build
```

产物在 `build/darwin-arm64/`：`Notefloat.app` 和 `Notefloat <版本> arm64.dmg`，版本号取自 `mygo.config.ts`。装到本机就是把 `Notefloat.app` 复制到 `/Applications`。

目前是 ad-hoc 签名、没有公证，首次打开会被系统拦下，要去「系统设置 > 隐私与安全性 > 仍要打开」。
或者使用命令：

```sh
xattr -dr com.apple.quarantine /Applications/Notefloat.app
```
