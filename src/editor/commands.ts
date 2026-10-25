// What the keys do to the note, as changes to its text. A block is a run of
// lines between separators, a todo is a prefix, a picture is a line: every
// command here is a change to the document, and the caret follows it.
import { EditorSelection, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { blockAt, blockNumber, blockRanges, flipTodoCheck, isPicture, isSeparator, lineKind, picturePath, SEPARATOR } from "./model";
import { doneOf, setDoneBlocks } from "./widgets";

/** newBlockText is what goes between two blocks. */
const NEW_BLOCK = `\n${SEPARATOR}\n`;

/** flagsAround returns the note's finished flags with one block inserted at the
 * index, or taken out of it, so that every flag keeps naming its own block. */
function flagsAround(state: EditorState, at: number, block: boolean | null): boolean[] {
  const flags = [...doneOf(state)];
  while (flags.length < blockRanges(state.doc).length) flags.push(false);
  if (block === null) flags.splice(at, 1);
  else flags.splice(at, 0, block);
  return flags;
}

/** addBlockBelow puts a block under the one the caret is in, as ⌘↵ does. The
 * separator goes at the end of the block's own text, so the new block is the
 * empty line between it and the separator that was already there, and the caret
 * waits in it. */
export function addBlockBelow(view: EditorView): boolean {
  const { state } = view;
  const range = blockAt(state.doc, state.selection.main.head);
  const at = range.to;
  view.dispatch({
    changes: { from: at, insert: NEW_BLOCK },
    selection: EditorSelection.cursor(at + NEW_BLOCK.length),
    effects: setDoneBlocks.of(flagsAround(state, blockNumber(state.doc, range) + 1, false)),
    scrollIntoView: true,
  });
  return true;
}

/** addBlockAbove puts a block over the one the caret is in, as ⌘⇧↵ does, the
 * same way. */
export function addBlockAbove(view: EditorView): boolean {
  const { state } = view;
  const range = blockAt(state.doc, state.selection.main.head);
  const index = blockNumber(state.doc, range);
  if (range.from === 0) {
    const insert = `${SEPARATOR}\n`;
    view.dispatch({
      changes: { from: 0, insert },
      selection: EditorSelection.cursor(0),
      effects: setDoneBlocks.of(flagsAround(state, 0, false)),
      scrollIntoView: true,
    });
    return true;
  }
  view.dispatch({
    changes: { from: range.from, insert: NEW_BLOCK },
    selection: EditorSelection.cursor(range.from + 1),
    effects: setDoneBlocks.of(flagsAround(state, index, false)),
    scrollIntoView: true,
  });
  return true;
}

/** splitBlock breaks the block at the caret, as ⌥↵ does: what stands after the
 * caret goes to a block of its own under it. */
export function splitBlock(view: EditorView): boolean {
  const { state } = view;
  const at = state.selection.main.head;
  view.dispatch({
    changes: { from: at, insert: NEW_BLOCK },
    selection: EditorSelection.cursor(at + NEW_BLOCK.length),
    effects: setDoneBlocks.of(flagsAround(state, blockNumber(state.doc, blockAt(state.doc, at)) + 1, false)),
    scrollIntoView: true,
  });
  return true;
}

/** goToBlock moves the caret to the start of the next or previous block. */
export function goToBlock(view: EditorView, step: -1 | 1): boolean {
  const { state } = view;
  const ranges = blockRanges(state.doc);
  const head = state.selection.main.head;
  const index = ranges.findIndex((range) => head >= range.from && head <= range.to);
  const to = index + step;
  if (index < 0 || to < 0 || to >= ranges.length) return false;
  view.dispatch({ selection: EditorSelection.cursor(ranges[to]!.from), scrollIntoView: true });
  return true;
}

/** selectBlock takes the block the caret is in; a second press takes the whole
 * note. The block is the unit a note is written and copied in. */
export function selectBlock(view: EditorView): boolean {
  const { state } = view;
  const selection = state.selection.main;
  const range = blockAt(state.doc, selection.head);
  const whole = selection.from === range.from && selection.to === range.to;
  if (whole || state.doc.length === 0) {
    view.dispatch({ selection: EditorSelection.range(0, state.doc.length) });
    return true;
  }
  view.dispatch({ selection: EditorSelection.range(range.from, range.to) });
  return true;
}

/** moveBlock swaps the block the caret is in with the one above or below it,
 * and the caret goes along with its block. */
export function moveBlock(view: EditorView, step: -1 | 1): boolean {
  const { state } = view;
  const head = state.selection.main.head;
  const ranges = blockRanges(state.doc);
  const index = ranges.findIndex((range) => head >= range.from && head <= range.to);
  const other = index + step;
  if (index < 0 || other < 0 || other >= ranges.length) return false;
  const here = ranges[index]!;
  const there = ranges[other]!;
  const hereText = state.doc.sliceString(here.from, here.to);
  const thereText = state.doc.sliceString(there.from, there.to);
  const from = Math.min(here.from, there.from);
  const to = Math.max(here.to, there.to);
  const insert = step < 0 ? `${hereText}\n${SEPARATOR}\n${thereText}` : `${thereText}\n${SEPARATOR}\n${hereText}`;
  const start = step < 0 ? there.from : here.from + thereText.length + SEPARATOR.length + 2;
  // The two blocks swap places, and so do their finish flags.
  const flags = [...doneOf(state)];
  while (flags.length < ranges.length) flags.push(false);
  [flags[index], flags[other]] = [flags[other]!, flags[index]!];
  view.dispatch({
    changes: { from, to, insert },
    selection: EditorSelection.cursor(start + (head - here.from)),
    effects: setDoneBlocks.of(flags),
    scrollIntoView: true,
  });
  return true;
}

/** toggleTodo adds the note's todo prefix to the line the caret is in, or takes
 * it away, as ⌘L does. */
export function toggleTodo(view: EditorView): boolean {
  const { state } = view;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const kind = lineKind(line.text);
  if (kind.kind === "todo") {
    view.dispatch({
      changes: { from: line.from, to: line.from + kind.prefix, insert: "" },
      selection: EditorSelection.cursor(Math.max(line.from, head - kind.prefix)),
      scrollIntoView: true,
    });
    return true;
  }
  const prefix = "- [ ] ";
  view.dispatch({
    changes: { from: line.from, insert: prefix },
    selection: EditorSelection.cursor(head + prefix.length),
    scrollIntoView: true,
  });
  return true;
}

/** toggleLineCheck flips the box of the todo line the caret is in, as ⌘⇧L does,
 * and leaves a line that is no todo alone: an open box is checked, a checked one
 * is emptied. */
export function toggleLineCheck(view: EditorView): boolean {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const kind = lineKind(line.text);
  if (kind.kind !== "todo") return false;
  const prefix = flipTodoCheck(line.text.slice(0, kind.prefix));
  view.dispatch({ changes: { from: line.from, to: line.from + kind.prefix, insert: prefix } });
  return true;
}

/** toggleBlockDone finishes the block the caret is in, as ⌘B does, or opens it
 * again: the block dims as a whole, and its text stays the text it was. */
export function toggleBlockDone(view: EditorView): boolean {
  const { state } = view;
  const index = blockNumber(state.doc, blockAt(state.doc, state.selection.main.head));
  if (index < 0) return false;
  const flags = [...doneOf(state)];
  while (flags.length < blockRanges(state.doc).length) flags.push(false);
  flags[index] = !flags[index];
  view.dispatch({ effects: setDoneBlocks.of(flags) });
  return true;
}

/** pictureLine names the picture the caret stands on, if it does. */
export function pictureLine(state: EditorState): { from: number; to: number; path: string } | null {
  const line = state.doc.lineAt(state.selection.main.head);
  const path = picturePath(line.text);
  return path === null ? null : { from: line.from, to: line.to, path };
}

/** deletePicture removes the picture the caret stands on, line and all. */
export function deletePicture(view: EditorView): boolean {
  const found = pictureLine(view.state);
  if (!found) return false;
  const line = view.state.doc.lineAt(found.from);
  const from = line.from > 0 ? line.from - 1 : 0;
  const to = Math.min(view.state.doc.length, line.to + 1);
  view.dispatch({ changes: { from, to, insert: "" }, selection: EditorSelection.cursor(from), scrollIntoView: true });
  return true;
}

/** deleteEmptyBlock removes a block that is one empty line, together with the
 * separator tying it to its neighbour: what Backspace on an empty block does. */
export function deleteEmptyBlock(view: EditorView): boolean {
  const { state } = view;
  const selection = state.selection.main;
  if (!selection.empty) return false;
  const range = blockAt(state.doc, selection.head);
  const first = state.doc.lineAt(range.from);
  const last = state.doc.lineAt(range.to);
  if (first.number !== last.number || first.text.trim() !== "") return false;
  if (blockRanges(state.doc).length === 1) return false;
  // The block goes, and so does its finish flag.
  const flags = flagsAround(state, blockNumber(state.doc, range), null);
  if (range.to < state.doc.length) {
    const separator = state.doc.lineAt(range.to + 1);
    const to = Math.min(state.doc.length, separator.to + 1);
    view.dispatch({
      changes: { from: range.from, to, insert: "" },
      selection: EditorSelection.cursor(Math.min(range.from, state.doc.length - (to - range.from))),
      effects: setDoneBlocks.of(flags),
      scrollIntoView: true,
    });
    return true;
  }
  const separator = state.doc.lineAt(Math.max(0, range.from - 1));
  const from = Math.max(0, separator.from - 1);
  view.dispatch({
    changes: { from, to: state.doc.length, insert: "" },
    selection: EditorSelection.cursor(from),
    effects: setDoneBlocks.of(flags),
    scrollIntoView: true,
  });
  return true;
}

/** backspace keeps the blocks apart: a picture line goes whole, an empty block
 * goes with its separator, and the start of a block joins nothing. */
export function backspace(view: EditorView): boolean {
  if (deletePicture(view)) return true;
  if (deleteEmptyBlock(view)) return true;
  const { state } = view;
  const selection = state.selection.main;
  if (!selection.empty) return false;
  const line = state.doc.lineAt(selection.head);
  if (selection.head !== line.from) return false;
  const range = blockAt(state.doc, selection.head);
  // Joining the line above would pull a separator into the text.
  return line.from === range.from;
}

/** deleteForward keeps Delete from joining a line onto a separator or onto a
 * picture, which would leave their text in the middle of a line. */
export function deleteForward(view: EditorView): boolean {
  const { state } = view;
  const selection = state.selection.main;
  if (!selection.empty) return false;
  const line = state.doc.lineAt(selection.head);
  if (selection.head !== line.to || line.number >= state.doc.lines) return false;
  const next = state.doc.line(line.number + 1).text;
  return isPicture(next) || isSeparator(next);
}
