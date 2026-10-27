# Changelog

One section per build, newest first. The section lands together with the patch number in `mygo.config.ts`, so the two always agree: see 版本号 in AGENTS.md.

## 0.1.4 — 2026-10-27

### Added

- The development build's menu bar icon carries a badge: a D in its lower left corner, and a hover tooltip reading Notefloat Dev. The release icon is unchanged, so the two are easy to tell apart when both sit in the menu bar.

### Changed

- Deleting a picture follows a set of rules of its own. Delete at a picture's left edge, Backspace at its right edge, and the picture itself goes, its line left empty; the next press takes that empty line away. A delete key pressed at the end of the line above or the start of the line below reaches no picture.
- Right at a picture's left edge moves the caret to its right edge, and left moves it back; leaving from either end steps over the ∞∞∞ line between blocks and lands on the neighbouring block's line.
- A press on a picture leaves the caret at whichever end the pointer was nearer.
- Backspace on a block's first line takes the separator above it away, so the two blocks become one.
- A picture's line takes no typing: characters, spaces, input methods and dropped text all leave it as it was, so one stray character no longer turns a picture back into a line of hash. ⌘X on a picture deletes the picture alone, and ⌘⌦ does nothing.
- A long run with no space in it, a path or a link, no longer jumps whole to the next line: it carries on from the line it starts on and continues from the next line's start once that line is full. Prose still breaks at its spaces.
- The scrollbar is thinner: 6 px across the panel, without the pale track or the buttons at either end.
- The empty block at the end of a note is a real block, written in the file: once the last block holds text, the ∞∞∞ line and the empty line after it sit below it, and a press there writes in it, no aiming at a blank area that is drawn but not written. A note therefore always ends in an empty block, and so does the file it is saved as.

### Fixed

- A narrow panel used to fold a picture's line into two rows, leaving the caret alone on the row above the picture with no arrow key working.
- Deleting the first picture used to pull the second picture's path into the line above, so the picture stopped rendering and its hash came out as prose.

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
