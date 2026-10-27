// The note's file format, read as text. The document string is the note: the
// editor never keeps a second copy of it, and everything below works on the
// text alone. A block is a run of lines between two ∞∞∞ lines.
import { Text } from "@codemirror/state";

export const IMAGE_DIR = "images/";
export const SEPARATOR = "∞∞∞";

const SEPARATOR_LINE = /^∞∞∞\S*$/;
const TODO_LINE = /^(\s*)- \[([ xX])\] ?/;
const PICTURE_LINE = /^((?:images\/|\/).*\.(?:png|jpe?g|gif|webp|heic))\s*$/;

/** BlockMarks is what a block is kept as beyond its text: the user finished it,
 * or folded it away. They ride on the separator line that closes the block, as
 * |done and |folded, which nothing on screen draws. */
export type BlockMarks = { done: boolean; folded: boolean };

/** marksOf reads the words a separator line carries after its ∞∞∞. */
function marksOf(text: string): BlockMarks {
  const words = text.slice(SEPARATOR.length).split("|");
  return { done: words.includes("done"), folded: words.includes("folded") };
}

/** separatorMark is a block's marks written as the separator line that closes
 * it. A block with no mark keeps the bare ∞∞∞ the file has always held. */
export function separatorMark({ done, folded }: BlockMarks): string {
  return SEPARATOR + (done ? "|done" : "") + (folded ? "|folded" : "");
}

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

/** Block is one run of lines between separators, with the marks the separator
 * that closes it carries. The blocks are the note's unit: what is finished,
 * folded or copied is a whole one. The block the note ends in has no separator
 * of its own, so it holds no marks and takes none. */
export type Block = BlockMarks & {
  from: number;
  to: number;
  /** The offset of the line that closes the block, or null for the note's last
   * block. */
  separator: number | null;
};

/** blocks reads the note as the blocks it is made of. A separator line belongs
 * to no block: it is the boundary two blocks meet at, and the only place the
 * note keeps what became of the block above it. */
export function blocks(doc: Text): Block[] {
  const found: Block[] = [];
  let from = 0;
  for (let number = 1; number <= doc.lines; number++) {
    const line = doc.line(number);
    if (!isSeparator(line.text)) continue;
    const to = Math.max(from, line.from - 1);
    const marks = marksOf(line.text);
    found.push({ from, to, separator: line.from, ...marks });
    from = Math.min(doc.length, line.to + 1);
  }
  found.push({ from, to: doc.length, separator: null, done: false, folded: false });
  return found;
}

/** blockAt names the block a position sits in. A position before a separator
 * belongs to the block above it. */
export function blockAt(doc: Text, pos: number): Block {
  const found = blocks(doc);
  for (const block of found) {
    if (pos >= block.from && pos <= block.to) return block;
  }
  return found[found.length - 1]!;
}

/** tailOf is what the note still needs to end in an empty block: the separator
 * under a last block that holds text and the empty line that follows it, the
 * break a note ending in a separator still wants, or nothing at all. The note's
 * tail is a block like any other, written down, not drawn in front of the text. */
export function tailOf(doc: Text): string {
  if (doc.length === 0) return "";
  const last = doc.line(doc.lines);
  if (last.text !== "") return isSeparator(last.text) ? "\n" : `\n${SEPARATOR}\n`;
  const above = doc.lines > 1 ? doc.line(doc.lines - 1).text : "";
  return isSeparator(above) ? "" : `${SEPARATOR}\n`;
}

/** tailed is a note's text as the editor holds it: ending in the empty block the
 * caret can be written in without reaching for a key first. */
export function tailed(text: string): string {
  return text + tailOf(Text.of(text.split("\n")));
}
