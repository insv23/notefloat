// What the keys do to the note, as changes to its text. A block is a run of
// lines between separators, a todo is a prefix, a picture is a line: every
// command here is a change to the document, and the caret follows it. The one
// rule that is not a key lives here too: a picture's line holds nothing but its
// path, so an edit that would leave text on it is refused.
import { Annotation, EditorSelection, type EditorState, type Line, type Text, type Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { blockAt, blockNumber, blockRanges, flipTodoCheck, isPicture, isSeparator, lineKind, SEPARATOR } from "./model";
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

/** ownEdit marks a change the editor made after checking it itself: a picture's
 * path travels with its block when blocks move, and the filter that keeps a
 * picture's line whole has only the text around it to guard. */
const ownEdit = Annotation.define<boolean>();

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
    annotations: ownEdit.of(true),
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

/** clearPicture takes the picture away and leaves its line empty: the path is the
 * whole line, so what remains is a line the caret can sit in, and the break under
 * it stays. Taking that empty line away is the press after this one. */
export function clearPicture(view: EditorView, line: Line): boolean {
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: "" },
    selection: EditorSelection.cursor(line.from),
    scrollIntoView: true,
  });
  return true;
}

/** removeAbove takes away what stands between a line and the block above it: the
 * separator line, which merges the two blocks, or an empty line, which holds
 * nothing but its break. A line of text or a picture above it stays, because
 * joining onto one would take its text or its path along. */
function removeAbove(view: EditorView, line: Line): boolean {
  const { state } = view;
  const { doc } = state;
  if (line.from === 0) return true;
  const above = doc.lineAt(line.from - 1);
  if (isSeparator(above.text)) {
    const index = blockNumber(doc, blockAt(doc, line.from));
    view.dispatch({
      changes: { from: above.from, to: Math.min(doc.length, above.to + 1), insert: "" },
      effects: setDoneBlocks.of(flagsAround(state, index, null)),
      scrollIntoView: true,
    });
    return true;
  }
  if (above.text.trim() !== "") return true;
  view.dispatch({ changes: { from: above.to, to: above.to + 1, insert: "" }, scrollIntoView: true });
  return true;
}

/** removeBelow takes the break under a picture away when the line below it is
 * empty: the picture keeps its line and loses only the blank row under it. A line
 * with text in it stays, because joining it onto the picture would take the path
 * along. The boundary under a block is not this key's to take: only the boundary
 * above a block goes, and only to Backspace. */
function removeBelow(view: EditorView, line: Line): boolean {
  const { doc } = view.state;
  if (line.to >= doc.length) return true;
  const below = doc.lineAt(line.to + 1);
  if (below.text.trim() !== "") return true;
  view.dispatch({ changes: { from: line.to, to: line.to + 1, insert: "" }, scrollIntoView: true });
  return true;
}

/** joinWouldBreakPicture tells whether the break above a line has to stay: a line
 * joined onto a picture would carry the path into the middle of the text, and the
 * picture with it. */
function joinWouldBreakPicture(doc: Text, line: Line): boolean {
  if (line.from === 0 || line.text.trim() === "") return false;
  return isPicture(doc.lineAt(line.from - 1).text);
}

/** stepAcrossPicture moves the caret along a picture the way the line reads:
 * from either end to the other, and from there out to the line beside it. The
 * path is hidden behind the picture, so the browser's own caret movement has no
 * text on that line to land on and both keys would stop dead. */
export function stepAcrossPicture(view: EditorView, forward: boolean, extend: boolean): boolean {
  const { state } = view;
  const selection = state.selection.main;
  if (!selection.empty) return false;
  const line = state.doc.lineAt(selection.head);
  if (!isPicture(line.text)) return false;
  const at = forward
    ? selection.head === line.from
      ? line.to
      : caretBeside(state.doc, line, 1)
    : selection.head === line.to
      ? line.from
      : caretBeside(state.doc, line, -1);
  view.dispatch({
    selection: extend ? EditorSelection.range(selection.anchor, at) : EditorSelection.cursor(at),
    scrollIntoView: true,
  });
  return true;
}

/** caretBeside is where the caret stands off a line: the start of the nearest
 * line below it, or the end of the nearest line above. A separator has no place
 * of its own for the caret, so it is stepped over whole. */
function caretBeside(doc: Text, line: Line, step: -1 | 1): number {
  for (let number = line.number + step; number >= 1 && number <= doc.lines; number += step) {
    const beside = doc.line(number);
    if (!isSeparator(beside.text)) return step < 0 ? beside.to : beside.from;
  }
  return step < 0 ? 0 : doc.length;
}

/** deleteEmptyBlock removes a block that is one empty line, together with the
 * separator tying it to its neighbour: what Backspace on an empty block does. */
function deleteEmptyBlock(view: EditorView): boolean {
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

/** backspace keeps the blocks apart and the pictures whole. A picture answers the
 * key by its side: from its right end the path goes and its line stays empty, and
 * from its left end the break above it goes when that break holds an empty line.
 * A line at the head of a block takes the separator above it away, and a line
 * joined onto a picture stays where it is. */
export function backspace(view: EditorView): boolean {
  const { state } = view;
  const selection = state.selection.main;
  if (!selection.empty) return false;
  const line = state.doc.lineAt(selection.head);
  if (isPicture(line.text)) {
    return selection.head === line.to ? clearPicture(view, line) : removeAbove(view, line);
  }
  if (deleteEmptyBlock(view)) return true;
  if (selection.head !== line.from) return false;
  if (line.from === blockAt(state.doc, selection.head).from) return removeAbove(view, line);
  // The same break is the picture's right end seen from the line below it.
  return joinWouldBreakPicture(state.doc, line);
}

/** deleteForward takes a picture from its left end and, from its right end, only
 * the break under an empty line. Where Delete would join a picture's path or a
 * separator onto the line it stands on, the key is swallowed. */
export function deleteForward(view: EditorView): boolean {
  const { state } = view;
  const selection = state.selection.main;
  if (!selection.empty) return false;
  const line = state.doc.lineAt(selection.head);
  if (isPicture(line.text)) {
    return selection.head === line.to ? removeBelow(view, line) : clearPicture(view, line);
  }
  if (selection.head !== line.to || line.number >= state.doc.lines) return false;
  const next = state.doc.line(line.number + 1).text;
  return isPicture(next) || isSeparator(next);
}

/** picturesKept refuses the edits that would end a picture. The path is the whole
 * line, so text typed into it or appended to it leaves a line that reads as text.
 * A break above or below the picture, a delete that takes the path away whole, and
 * the editor's own commands still pass. */
export function picturesKept(transaction: Transaction): boolean {
  if (transaction.annotation(ownEdit)) return true;
  // Undo and redo put back text that was accepted once already.
  if (transaction.isUserEvent("undo") || transaction.isUserEvent("redo")) return true;
  const { doc } = transaction.startState;
  const after = transaction.newDoc;
  let kept = true;
  transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (!kept) return;
    const inserted = after.sliceString(fromB, toB);
    const last = fromA === toA ? fromA : toA - 1;
    for (let number = doc.lineAt(fromA).number; number <= doc.lineAt(last).number; number++) {
      const line = doc.line(number);
      if (isPicture(line.text) && !sparesPictureLine(line, fromA, toA, inserted)) kept = false;
    }
  });
  return kept;
}

/** sparesPictureLine tells whether a change leaves a picture's own line as it was:
 * a delete that takes nothing of the path or all of it, or a break inserted at
 * either end of the line, which lands on the line beside it. */
function sparesPictureLine(line: Line, from: number, to: number, inserted: string): boolean {
  if (inserted === "") return from >= line.to || to <= line.from || (from <= line.from && to >= line.to);
  if (from !== to) return false;
  if (from === line.from) return inserted.endsWith("\n");
  if (from === line.to) return inserted.startsWith("\n");
  return false;
}
