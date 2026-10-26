# Changelog

One section per build, newest first. The section lands together with the patch number in `mygo.config.ts`, so the two always agree: see 版本号 in AGENTS.md.

## 0.1.3 — 2026-10-26

### Fixed

- The caret of an empty note was stretched by the placeholder: as many lines as the placeholder had, so tall was the caret drawn, one vertical line running through the whole of it. The placeholder is down to a single line now, and the caret is one line tall again. Every other shortcut stays listed in Settings › Shortcuts.

## 0.1.2 — 2026-10-25

### Added

- The sidebar's right edge drags to a width between 50 and 360 px, and the width is remembered: the next launch opens at the same one.

### Fixed

- The settings entry at the foot of the sidebar is the icon alone: the rule above it is gone, and Settings is no longer written out there, while the hover tooltip still names it and its shortcut.
- The pin of a pinned note used to stay in sight; it now appears only while the pointer is on the row, like the delete button. A pinned note's pin is solid and an unpinned one's is hollow, so the shape tells the state.
- A note row and a folder row no longer set room aside for their pin and their ×: until the pointer arrives the title uses the whole row width, and only then gives up the space, the end turning into an ellipsis.
- The Pinned section no longer shows a "Nothing pinned" placeholder when it is empty.

<!--
The next section follows the same shape: version and date, then Added, Changed, Fixed and Removed, with only what a user can see. The user reviews it in `CHANGELOG_zh.md` first; this file receives its translation.
-->
