// The note's file format, read as text. The document string is the note: the
// editor never keeps a second copy of it, and everything below works on the
// text alone. A block is a run of lines between two ∞∞∞ lines.
import type { Text } from "@codemirror/state";

export const IMAGE_DIR = "images/";
export const SEPARATOR = "∞∞∞";

const SEPARATOR_LINE = /^∞∞∞\S*$/;
const TODO_LINE = /^(\s*)- \[([ xX])\] ?/;
const PICTURE_LINE = /^((?:images\/|\/).*\.(?:png|jpe?g|gif|webp|heic))\s*$/;

export type LineKind =
  | { kind: "separator" }
  | { kind: "picture"; path: string }
  | { kind: "todo"; prefix: number; done: boolean }
  | { kind: "text" };

/** lineKind reads one line of the note file as what it stands for. */
export function lineKind(text: string): LineKind {
  if (SEPARATOR_LINE.test(text)) return { kind: "separator" };
  const picture = PICTURE_LINE.exec(text.trim());
  if (picture) return { kind: "picture", path: picture[1]! };
  const todo = TODO_LINE.exec(text);
  if (todo) return { kind: "todo", prefix: todo[0].length, done: todo[2] !== " " };
  return { kind: "text" };
}

export const isSeparator = (text: string) => SEPARATOR_LINE.test(text);
export const isPicture = (text: string) => PICTURE_LINE.test(text.trim());

/** flipTodoCheck turns a todo's prefix into the other state, and hands anything
 * that is no todo prefix back as it was. The mark is what the box draws: a line
 * checked here is checked in the file. */
export function flipTodoCheck(prefix: string): string {
  return prefix.replace(/\[([ xX])\]/, (_all, mark: string) => (mark === " " ? "[x]" : "[ ]"));
}

/** picturePath is the file under images/ that a line names, or null. */
export function picturePath(text: string): string | null {
  const picture = PICTURE_LINE.exec(text.trim());
  return picture ? picture[1]! : null;
}

export type BlockRange = { from: number; to: number };

/** blockRanges are the runs of lines between separators, by character offset.
 * A separator line belongs to neither block. */
export function blockRanges(doc: Text): BlockRange[] {
  const ranges: BlockRange[] = [];
  let from = 0;
  for (let number = 1; number <= doc.lines; number++) {
    const line = doc.line(number);
    if (!isSeparator(line.text)) continue;
    ranges.push({ from, to: Math.max(from, line.from - 1) });
    from = Math.min(doc.length, line.to + 1);
  }
  ranges.push({ from, to: doc.length });
  return ranges;
}

/** blockAt names the block a position sits in. A position before a separator
 * belongs to the block above it. */
export function blockAt(doc: Text, pos: number): BlockRange {
  const ranges = blockRanges(doc);
  for (const range of ranges) {
    if (pos >= range.from && pos <= range.to) return range;
  }
  return ranges[ranges.length - 1]!;
}

/** blockNumber is the block's place in the note, from 0. */
export function blockNumber(doc: Text, range: BlockRange): number {
  return blockRanges(doc).findIndex((other) => other.from === range.from && other.to === range.to);
}
