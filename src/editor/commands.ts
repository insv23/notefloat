// What the keys do to the note, as changes to its text. A block is a run of
// lines between separators, a todo is a prefix, a picture is a line: every
// command here is a change to the document, and the caret follows it. The one
// rule that is not a key lives here too: a picture's line holds nothing but its
// path, so an edit that would leave text on it is refused.
import { Annotation, EditorSelection, type Line, type Text, type Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { blockAt, blocks, flipTodoCheck, isPicture, isSeparator, lineKind, separatorMark, SEPARATOR, type Block } from "./model";

/** newBlockText is what goes between two blocks. */
const NEW_BLOCK = `\n${SEPARATOR}\n`;

/** markOf is the separator line that closes a block, marks and all. */
const markOf = (block: Block) => separatorMark({ done: block.done, folded: block.folded });

/** ownEdit marks a change the editor made after checking it itself: a picture's
 * path travels with its block when blocks move, and the filter that keeps a
 * picture's line whole has only the text around it to guard. */
const ownEdit = Annotation.define<boolean>();

/** addBlockBelow puts a block under the one the caret is in, as ⌘↵ does. The
 * new block goes under the separator that closes the one above it, so the marks
 * stay with the block they were written for. */
export function addBlockBelow(view: EditorView): boolean {
  const { state } = view;
  const block = blockAt(state.doc, state.selection.main.head);
  const at = block.separator === null ? block.to : state.doc.lineAt(block.separator).to + 1;
  const caret = block.separator === null ? at + NEW_BLOCK.length : at;
  view.dispatch({
    changes: { from: at, insert: NEW_BLOCK },
    selection: EditorSelection.cursor(caret),
    scrollIntoView: true,
  });
  return true;
}

/** addBlockAbove puts a block over the one the caret is in, as ⌘⇧↵ does, the
 * same way. */
export function addBlockAbove(view: EditorView): boolean {
  const { state } = view;
  const range = blockAt(state.doc, state.selection.main.head);
  if (range.from === 0) {
    const insert = `${SEPARATOR}\n`;
    view.dispatch({
      changes: { from: 0, insert },
      selection: EditorSelection.cursor(0),
      scrollIntoView: true,
    });
    return true;
  }
  view.dispatch({
    changes: { from: range.from, insert: NEW_BLOCK },
    selection: EditorSelection.cursor(range.from + 1),
    scrollIntoView: true,
  });
  return true;
}

/** splitBlock breaks the block at the caret, as ⌥↵ does: what stands after the
 * caret goes to a block of its own under it, and the marks stay with the part
 * the caret is in. */
export function splitBlock(view: EditorView): boolean {
  const { state } = view;
  const at = state.selection.main.head;
  const block = blockAt(state.doc, at);
  const insert = `\n${markOf(block)}\n`;
  const changes: { from: number; to?: number; insert: string }[] = [{ from: at, insert }];
  if (block.separator !== null) {
    const line = state.doc.lineAt(block.separator);
    changes.push({ from: line.from, to: line.to, insert: SEPARATOR });
  }
  view.dispatch({
    changes,
    selection: EditorSelection.cursor(at + insert.length),
    scrollIntoView: true,
  });
  return true;
}

/** goToBlock moves the caret to the start of the next or previous block. */
export function goToBlock(view: EditorView, step: -1 | 1): boolean {
  const { state } = view;
  const found = blocks(state.doc);
  const head = state.selection.main.head;
  const index = found.findIndex((block) => head >= block.from && head <= block.to);
  const to = index + step;
  if (index < 0 || to < 0 || to >= found.length) return false;
  view.dispatch({ selection: EditorSelection.cursor(found[to]!.from), scrollIntoView: true });
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

/** moveBlock swaps the block the caret is in with the one above or below it.
 * The marks come along: each separator is written again with the marks of the
 * block it closes, whichever way round the two blocks end up. */
export function moveBlock(view: EditorView, step: -1 | 1): boolean {
  const { state } = view;
  const head = state.selection.main.head;
  const found = blocks(state.doc);
  const index = found.findIndex((block) => head >= block.from && head <= block.to);
  const other = index + step;
  if (index < 0 || other < 0 || other >= found.length) return false;
  const here = found[index]!;
  const there = found[other]!;
  const upper = step < 0 ? there : here;
  const lower = step < 0 ? here : there;
  const from = upper.from;
  // The span takes in the separator that closes the lower block, so that both
  // boundaries come out of the change with the marks their block holds.
  const to = lower.separator === null ? lower.to : state.doc.lineAt(lower.separator).to;
  const upperText = state.doc.sliceString(upper.from, upper.to);
  const lowerText = state.doc.sliceString(lower.from, lower.to);
  const insert = `${lowerText}\n${markOf(lower)}\n${upperText}\n${markOf(upper)}`;
  // The caret travels with its block: to the lower block's new start when the
  // move took it down, and to the top of the span when it went up.
  const start = step < 0 ? from : from + lowerText.length + 1 + markOf(lower).length + 1;
  view.dispatch({
    changes: { from, to, insert },
    selection: EditorSelection.cursor(start + (head - here.from)),
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

/** setMarks writes what a block is kept as onto the separator that closes it.
 * The note's last block has no separator, and so nothing to write. */
function setMarks(view: EditorView, block: Block, marks: { done: boolean; folded: boolean }): boolean {
  if (block.separator === null) return false;
  const line = view.state.doc.lineAt(block.separator);
  view.dispatch({ changes: { from: line.from, to: line.to, insert: separatorMark(marks) } });
  return true;
}

/** toggleBlockDone finishes the block the caret is in, as ⌘B does, or opens it
 * again: the block dims as a whole, and its text stays the text it was. */
export function toggleBlockDone(view: EditorView): boolean {
  const { doc, selection } = view.state;
  const block = blockAt(doc, selection.main.head);
  return setMarks(view, block, { done: !block.done, folded: block.folded });
}

/** toggleBlockFold folds the block the caret is in away, as ⌘D does, or draws it
 * whole again. A folded block is the note read back, cut at the fold height: the
 * mark says folded whatever the block's height, and the height the settings hold
 * is what decides how much of it is drawn. */
export function toggleBlockFold(view: EditorView): boolean {
  const { doc, selection } = view.state;
  const block = blockAt(doc, selection.main.head);
  if (block.folded) return setMarks(view, block, { done: block.done, folded: false });
  if (block.separator === null) return false;
  const line = doc.lineAt(block.separator);
  const mark = separatorMark({ done: block.done, folded: true });
  // A folded block is a reading view: the caret cannot stand in one, so folding
  // the block the caret is in takes it down to the block below. The selection
  // names a place in the document the change leaves, so the start of the block
  // under the rewritten separator is counted from its length.
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: mark },
    selection: EditorSelection.cursor(line.from + mark.length + 1),
  });
  return true;
}

/** foldAllBlocks folds every block of the note, as ⌘⇧D does, or draws them all
 * whole again: one folded block anywhere means the press opens the note up. The
 * block the caret stands in is the one block left drawn whole, because a caret
 * cannot wait inside a fold. */
export function foldAllBlocks(view: EditorView): boolean {
  const { state } = view;
  const found = blocks(state.doc);
  const fold = !found.some((block) => block.folded);
  const changes = found
    .filter((block) => block.separator !== null && block.folded !== fold)
    .map((block) => {
      const line = state.doc.lineAt(block.separator!);
      return { from: line.from, to: line.to, insert: separatorMark({ done: block.done, folded: fold }) };
    });
  if (changes.length === 0) return true;
  view.dispatch({ changes });
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
    view.dispatch({
      changes: { from: above.from, to: Math.min(doc.length, above.to + 1), insert: "" },
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
 * separator tying it to its neighbour: what Backspace on an empty block does.
 * The note's last block is the empty one the editor keeps there, and the change
 * that takes it away would only write it again, so the key steps out of it
 * instead: the caret goes to the end of the block above. */
function deleteEmptyBlock(view: EditorView): boolean {
  const { state } = view;
  const selection = state.selection.main;
  if (!selection.empty) return false;
  const range = blockAt(state.doc, selection.head);
  if (range.from !== range.to || state.doc.lineAt(range.from).text.trim() !== "") return false;
  const found = blocks(state.doc);
  const index = found.findIndex((block) => block.from === range.from && block.to === range.to);
  if (found.length === 1) return false;
  if (index === found.length - 1) {
    const separator = state.doc.lineAt(range.from - 1);
    view.dispatch({ selection: EditorSelection.cursor(separator.from - 1), scrollIntoView: true });
    return true;
  }
  // The block goes, and the separator that closed it with it.
  const separator = state.doc.lineAt(range.to + 1);
  const to = Math.min(state.doc.length, separator.to + 1);
  view.dispatch({
    changes: { from: range.from, to, insert: "" },
    selection: EditorSelection.cursor(range.from),
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
