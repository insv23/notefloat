// The editor: a list of blocks, each rendered as plain DOM. A block is a group
// of lines with a hairline between it and the next block; a line is either plain
// text or a todo, and a todo's checkbox belongs to that one line. Pictures take
// their place among the lines and can be focused: Enter writes under one,
// Shift-Enter over it, Backspace removes it. The note file keeps the same shape: lines,
// pictures as their paths, `- [ ] ` in front of a todo line, and a line holding
// ∞∞∞ between blocks. The editor never shows ∞∞∞.
import { imeBusy } from "./ime";
import { accelFromEvent, canonical, formatAccel, hasModifier } from "./shortcuts";

const IMAGE_SCHEME = "notefloat-img";
const IMAGE_DIR = "images/";
const TODO_LINE = /^\s*- \[([ xX])\] ?(.*)$/;
// A picture line is a path under images/, relative to the data directory, or a
// whole path written by a version that kept them absolute.
const IMAGE_LINE = /^((?:images\/|\/).*\.(?:png|jpe?g|gif|webp|heic))\s*$/;
const BLOCK_SEPARATOR = /^∞∞∞\S*$/;
const HISTORY_GROUP_MS = 700;

/** Enter arrives spelled differently across WebKit versions, and Command-Enter
 * even more so; keyCode is the one field every path sets. */
function isEnterKey(event: KeyboardEvent): boolean {
  return event.key === "Enter" || event.key === "Return" || event.keyCode === 13;
}

type Item =
  | { kind: "line"; text: string; todo: boolean; done: boolean }
  | { kind: "image"; path: string };

type Block = {
  id: string;
  /** The block's content in order: lines and pictures. */
  items: Item[];
};

type Caret = "start" | "end" | { offset: number };

const uid = () => Math.random().toString(36).slice(2, 10);

const plainLine = (text = ""): Item => ({ kind: "line", text, todo: false, done: false });

/** lineFromText reads one line of the note as the note file writes it: a path
 * is a picture, a leading "- [ ] " or "- [x] " a todo. The editor reads the
 * same text the file holds, so what the user pastes renders at once. */
function lineFromText(line: string): Item {
  const path = IMAGE_LINE.exec(line.trim());
  if (path) return { kind: "image", path: path[1]! };
  const todo = TODO_LINE.exec(line);
  if (todo) return { kind: "line", text: todo[2] ?? "", todo: true, done: todo[1] !== " " };
  return plainLine(line);
}

function itemsFromLines(lines: string[]): Item[] {
  return lines.map(lineFromText);
}

function blockFromLines(lines: string[]): Block {
  const items = itemsFromLines(lines);
  if (items.length === 0) items.push(plainLine());
  return { id: uid(), items };
}

function parseNote(note: string): Block[] {
  const groups: string[][] = [[]];
  for (const line of note.split("\n")) {
    if (BLOCK_SEPARATOR.test(line)) groups.push([]);
    else groups[groups.length - 1]!.push(line);
  }
  return groups.map(blockFromLines);
}

function blockLines(block: Block): string[] {
  return block.items.map((item) => {
    if (item.kind === "image") return item.path;
    if (!item.todo) return item.text;
    return `- [${item.done ? "x" : " "}] ${item.text}`;
  });
}

function serializeNote(blocks: Block[]): string {
  return blocks.map((block) => blockLines(block).join("\n")).join("\n∞∞∞\n");
}

const emptyBlock = (): Block => ({ id: uid(), items: [plainLine()] });

export type NoteEditor = {
  focus: () => void;
  /** The note as its text file: the blocks, separated by ∞∞∞ lines. */
  text: () => string;
  /**
   * find selects the next line of the note holding query and returns which of
   * the note's matches that was. A step reads from the match the last call
   * left, a new query from that same match or from the top of the note.
   */
  find: (query: string, options: FindOptions) => FindResult;
  /**
   * reveal selects the match a search of every note found on a line of this
   * note's file, so that the caret lands where the sidebar's result points.
   */
  reveal: (line: number, query: string, options: { caseSensitive: boolean }) => void;
  /** clearFind drops the place a search left, so the next one starts afresh. */
  clearFind: () => void;
  /** selectionText is the text the caret holds selected, or the empty string. */
  selectionText: () => string;
  destroy: () => void;
};

/** FindOptions says how a query matches and which way to step from the last
 * match: back is Shift-Return, the match before the one the search stopped on. */
export type FindOptions = { caseSensitive: boolean; back: boolean };

/** FindResult counts the note's matches and names the one now selected, from 0;
 * a note without a match has -1. */
export type FindResult = { total: number; index: number };

export type EditorOptions = {
  doc: string;
  imagesDir: string;
  onChange: () => void;
  /** A short word in the title bar, so that what the keyboard did is visible. */
  onStatus?: (text: string) => void;
  /** Stores a pasted picture and returns its path, or null to insert nothing. */
  onImage: (file: File) => Promise<string | null>;
  /** binding is the accelerator the settings hold for an action, read on the
   * key press: the shortcut list changes while the editor stays. */
  binding: (action: string) => string;
};

/** placeholderText is what an empty note shows: the caret goes on the first
 * line, the keys that shape a note on the second, and what the panel is on the
 * third, so that no line runs past the edge of a narrow panel. The summoning
 * key is the user's own, and an action without one drops out of the line. */
function placeholderText(binding: EditorOptions["binding"]) {
  const summon = formatAccel(binding("togglePanel"));
  const keys = [summon && `${summon} summons`, "⌘L todo", "⌘↵ block", "Esc hides"];
  return ["Type here", keys.filter(Boolean).join(" · "), "Floating notes · todos · pasted pictures"].join("\n");
}

/** createEditor mounts the notes editor of a buffer. */
export function createEditor(parent: HTMLElement, options: EditorOptions): NoteEditor {
  const emptyHint = placeholderText(options.binding);

  /** portable rewrites a picture path that names the current data directory
   * into the relative path a note keeps. */
  function portable(items: Block[]) {
    const prefix = `${options.imagesDir}/`;
    for (const block of items) {
      for (const item of block.items) {
        if (item.kind === "image" && item.path.startsWith(prefix)) {
          item.path = IMAGE_DIR + item.path.slice(prefix.length);
        }
      }
    }
    return items;
  }

  let blocks = portable(parseNote(options.doc));
  let selected = new Set<string>();
  let lastFocusID = blocks[0]!.id;

  const root = document.createElement("div");
  root.className = "blocks";
  parent.append(root);

  // ---- history -----------------------------------------------------------

  const undoStack: { note: string; index: number }[] = [];
  const redoStack: { note: string; index: number }[] = [];
  let lastPushAt = 0;

  const noteText = () => serializeNote(blocks);

  /** busyIndex is the block the caret is in, -1 when it is elsewhere. */
  function busyIndex(): number {
    const active = document.activeElement;
    if (!(active instanceof HTMLTextAreaElement)) return -1;
    const row = active.closest(".blk");
    return row instanceof HTMLElement ? [...root.children].indexOf(row) : -1;
  }

  /**
   * beginChange records the note as it was, before a change. Typing groups into
   * one step while it stays in the same block, so a burst of keystrokes undoes
   * at once and a structural change is a step of its own.
   */
  function beginChange() {
    const now = performance.now();
    if (now - lastPushAt < HISTORY_GROUP_MS) return;
    undoStack.push({ note: noteText(), index: Math.max(0, busyIndex()) });
    if (undoStack.length > 300) undoStack.shift();
    redoStack.length = 0;
    lastPushAt = now;
  }

  function beginStructuralChange() {
    lastPushAt = 0;
    beginChange();
  }

  function restore(note: string, index: number) {
    blocks = portable(parseNote(note));
    selected = new Set();
    lastPushAt = 0;
    render({ block: Math.min(index, blocks.length - 1), item: 0, caret: "end" });
    options.onChange();
  }

  function undo() {
    const entry = undoStack.pop();
    if (!entry) return;
    redoStack.push({ note: noteText(), index: Math.max(0, busyIndex()) });
    restore(entry.note, entry.index);
  }

  function redo() {
    const entry = redoStack.pop();
    if (!entry) return;
    undoStack.push({ note: noteText(), index: Math.max(0, busyIndex()) });
    restore(entry.note, entry.index);
  }

  // ---- rendering ---------------------------------------------------------

  /** imageURL asks the scheme for a picture by the path under images/. A note
   * from before relative paths names the whole path: the part after images/ is
   * all the scheme needs, and that part is what a moved directory keeps. */
  function imageURL(path: string): string {
    if (path.startsWith(IMAGE_DIR)) return `${IMAGE_SCHEME}://localhost/${path.slice(IMAGE_DIR.length)}`;
    const prefix = `${options.imagesDir}/`;
    if (path.startsWith(prefix)) return `${IMAGE_SCHEME}://localhost/${path.slice(prefix.length)}`;
    const at = path.lastIndexOf(`/${IMAGE_DIR}`);
    return at < 0 ? "" : `${IMAGE_SCHEME}://localhost/${path.slice(at + IMAGE_DIR.length + 1)}`;
  }

  function autosize(area: HTMLTextAreaElement) {
    area.style.height = "auto";
    // An empty line's insertion point sits on the bottom edge of its box, which
    // the editor's scrolling layer clips away on a long note: two pixels of
    // headroom keep it inside. A line with text keeps the height its text needs.
    const headroom = area.value === "" ? 2 : 0;
    area.style.height = `${area.scrollHeight + headroom}px`;
  }

  function focusRun(at: { block: number; item: number; caret: Caret }) {
    const blockIndex = Math.min(Math.max(at.block, 0), blocks.length - 1);
    const block = blocks[blockIndex];
    if (!block) return;
    let item = at.item;
    const target = block.items[item];
    if (target?.kind === "image") {
      // A picture takes the keyboard: Enter adds a line under it, Backspace
      // removes it.
      focusPicture(blockIndex, item);
      return;
    }
    if (!target) {
      item = block.items.findIndex((entry) => entry.kind === "line");
      if (item < 0) return;
    }
    const area = root.querySelector<HTMLTextAreaElement>(
      `textarea[data-block="${blockIndex}"][data-item="${item}"]`,
    );
    if (!area) return;
    area.focus();
    const position =
      at.caret === "start"
        ? 0
        : at.caret === "end"
          ? area.value.length
          : Math.min(at.caret.offset, area.value.length);
    area.setSelectionRange(position, position);
    // A long note puts the editor in its own scrolling layer, and that layer
    // drops the caret of a line with no text: nothing in the line repaints. An
    // invisible outline asks for that repaint once the scroll has landed.
    requestAnimationFrame(() => {
      if (document.activeElement !== area) return;
      const line = area.closest(".blk-line");
      if (!(line instanceof HTMLElement)) return;
      line.style.outline = "1px solid transparent";
      requestAnimationFrame(() => {
        line.style.outline = "";
      });
    });
  }

  /** neighbour walks the lines of the note in order, pictures included: the
   * arrows find the next line with it, stepping over the pictures between. */
  function neighbour(blockIndex: number, itemIndex: number, step: 1 | -1): { block: number; item: number } | null {
    let block = blockIndex;
    let item = itemIndex;
    for (;;) {
      item += step;
      if (item < 0) {
        block -= 1;
        if (block < 0) return null;
        item = blocks[block]!.items.length - 1;
      } else if (item >= blocks[block]!.items.length) {
        block += 1;
        if (block >= blocks.length) return null;
        item = 0;
      }
      if (blocks[block]!.items[item]!.kind === "line") return { block, item };
    }
  }

  /** stopAt steps one item at a time, pictures included: that is how a picture
   * is reached with the arrows, so that a line can be added under it. */
  function stopAt(blockIndex: number, itemIndex: number, step: 1 | -1): { block: number; item: number } | null {
    let block = blockIndex;
    let item = itemIndex + step;
    if (item < 0) {
      block -= 1;
      if (block < 0) return null;
      item = blocks[block]!.items.length - 1;
    } else if (item >= blocks[block]!.items.length) {
      block += 1;
      if (block >= blocks.length) return null;
      item = 0;
    }
    return { block, item };
  }

  function focusPicture(blockIndex: number, itemIndex: number) {
    root
      .querySelector<HTMLElement>(`.blk-pic[data-block="${blockIndex}"][data-item="${itemIndex}"]`)
      ?.focus();
  }

  /** addLineAt puts an empty line next to a picture, under it by default and
   * over it with Shift held. */
  function addLineAt(blockIndex: number, itemIndex: number, above: boolean) {
    const block = blocks[blockIndex];
    if (!block) return;
    beginStructuralChange();
    const at = above ? itemIndex : itemIndex + 1;
    block.items.splice(at, 0, plainLine());
    render({ block: blockIndex, item: at, caret: "start" });
    options.onChange();
  }

  function deletePictureAt(blockIndex: number, itemIndex: number) {
    const block = blocks[blockIndex];
    if (!block) return;
    beginStructuralChange();
    block.items.splice(itemIndex, 1);
    if (block.items.length === 0) {
      if (blocks.length > 1) blocks.splice(blockIndex, 1);
      else block.items.push(plainLine());
    }
    const at = Math.min(blockIndex, blocks.length - 1);
    const item = Math.min(itemIndex, blocks[at]!.items.length - 1);
    render({ block: at, item: Math.max(0, item), caret: "end" });
    options.onChange();
  }

  function picture(block: Block, blockIndex: number, path: string, itemIndex: number): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "blk-pic";
    wrap.tabIndex = -1;
    wrap.dataset.block = String(blockIndex);
    wrap.dataset.item = String(itemIndex);
    // The whole path is what ⌘C hands out for a focused picture.
    wrap.dataset.path = absolute(path);
    const img = document.createElement("img");
    img.src = imageURL(path);
    img.alt = path.split("/").pop() ?? "Picture";
    // The tooltip names the picture where it is on disk, the same whole path
    // a copy of the note hands out.
    img.title = absolute(path);
    img.loading = "lazy";
    const remove = document.createElement("button");
    remove.className = "blk-pic-remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Remove Picture";
    remove.addEventListener("mousedown", (event) => event.preventDefault());
    remove.addEventListener("click", () => {
      beginStructuralChange();
      block.items.splice(itemIndex, 1);
      if (block.items.length === 0) block.items.push(plainLine());
      const at = block.items.findIndex((item) => item.kind === "line");
      render({ block: blockIndex, item: Math.max(0, at), caret: "end" });
      options.onChange();
    });
    // The pointer takes the picture into focus; from there the keyboard writes
    // around it.
    img.addEventListener("mousedown", (event) => {
      event.preventDefault();
      wrap.focus();
    });
    // ⌘C hands out dataset.path through the page's copy event, see onCopy: the
    // path is never put in the document's selection, because WebKit then stops
    // drawing the caret of every line, an empty line most of all.
    wrap.addEventListener("keydown", (event) => {
      // A key the input method is using is not the editor's, Enter included.
      if (imeBusy(event)) return;
      const meta = event.metaKey || event.ctrlKey;
      if (isEnterKey(event) && !meta) {
        event.preventDefault();
        event.stopPropagation();
        addLineAt(blockIndex, itemIndex, event.shiftKey);
        return;
      }
      if (meta && event.key.toLowerCase() === "c") {
        // A key the menu bar did let through copies the focused picture's path;
        // the clipboard handler fills in the same text and says so.
        event.preventDefault();
        event.stopPropagation();
        document.execCommand("copy");
        return;
      }
      if (!meta && (event.key === "Backspace" || event.key === "Delete")) {
        event.preventDefault();
        event.stopPropagation();
        deletePictureAt(blockIndex, itemIndex);
        return;
      }
      const step = blockStep(event);
      if (step !== 0) {
        event.preventDefault();
        event.stopPropagation();
        moveBlock(blockIndex, step, { item: itemIndex, caret: { offset: 0 } });
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        const stop = stopAt(blockIndex, itemIndex, event.key === "ArrowUp" ? -1 : 1);
        if (stop) {
          event.preventDefault();
          event.stopPropagation();
          focusRun({ ...stop, caret: "end" });
        }
      }
    });
    wrap.append(img, remove);
    return wrap;
  }

  function blockRow(block: Block, blockIndex: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "blk";
    row.dataset.id = block.id;
    if (selected.has(block.id)) row.classList.add("selected");

    block.items.forEach((item, itemIndex) => {
      if (item.kind === "image") {
        row.append(picture(block, blockIndex, item.path, itemIndex));
        return;
      }

      const line = document.createElement("div");
      line.className = "blk-line";
      if (item.todo && item.done) line.classList.add("done");

      if (item.todo) {
        const box = document.createElement("input");
        box.type = "checkbox";
        box.className = "blk-check";
        box.checked = item.done;
        box.setAttribute("aria-label", item.done ? "Mark as not done" : "Mark as done");
        // The press must not take the caret out of the text beside it.
        box.addEventListener("mousedown", (event) => event.preventDefault());
        box.addEventListener("change", () => {
          beginStructuralChange();
          item.done = box.checked;
          line.classList.toggle("done", item.done);
          box.setAttribute("aria-label", item.done ? "Mark as not done" : "Mark as done");
          options.onChange();
        });
        line.append(box);
      }

      const area = document.createElement("textarea");
      area.rows = 1;
      area.spellcheck = false;
      area.value = item.text;
      area.dataset.block = String(blockIndex);
      area.dataset.item = String(itemIndex);
      if (blockIndex === 0 && block.items.length === 1 && item.text === "") {
        area.placeholder = emptyHint;
      }
      area.addEventListener("input", (event) => {
        // Markdown the user typed or pasted becomes what it stands for before
        // the line is written back, so that a copied todo renders as a todo.
        // An input method's own updates are left alone.
        if (!(event as InputEvent).isComposing && recognizeLine(blockIndex, itemIndex, area.value)) return;
        beginChange();
        item.text = area.value;
        autosize(area);
        options.onChange();
      });
      area.addEventListener("focus", () => {
        lastFocusID = block.id;
        selected = new Set();
        paintSelection();
      });
      area.addEventListener("paste", (event) => onPaste(event, blockIndex, itemIndex, item));
      line.append(area);
      row.append(line);
    });

    return row;
  }

  function render(focus?: { block: number; item: number; caret: Caret }) {
    root.replaceChildren(...blocks.map((block, index) => blockRow(block, index)));
    // The rows are new: a mark drawn over one of the old ones went with them.
    mark = null;
    for (const area of root.querySelectorAll("textarea")) autosize(area);
    if (focus) focusRun(focus);
  }

  function paintSelection() {
    for (const child of root.children) {
      if (child instanceof HTMLElement) child.classList.toggle("selected", selected.has(child.dataset.id ?? ""));
    }
  }

  // ---- search ------------------------------------------------------------

  /** searchPos is the match the last find left, by block id so that it still
   * names the same place after the note was rendered again. */
  let searchPos: { block: string; item: number; offset: number } | null = null;
  /** lastFind says which query searchPos belongs to: stepping continues that
   * search, a different query only keeps the place. */
  let lastFind = { query: "", caseSensitive: false };
  /** mark is the box drawn over the word the search stopped on. */
  let mark: HTMLElement | null = null;

  /** occurrences returns where needle starts in text, which is what both the
   * count and the selection a search leaves are made of. */
  function occurrences(text: string, needle: string, caseSensitive: boolean): number[] {
    const at: number[] = [];
    if (needle === "") return at;
    const hay = caseSensitive ? text : text.toLowerCase();
    const wanted = caseSensitive ? needle : needle.toLowerCase();
    for (let i = hay.indexOf(wanted); i >= 0; i = hay.indexOf(wanted, i + wanted.length)) at.push(i);
    return at;
  }
  /**
   * placeMark draws a box over one run of a line's text. A text field paints no
   * part of its own text without the caret in it, so the run is laid out again
   * in a hidden copy of the field, its place is measured there, and a box is
   * put over the field at that place: the word alone reads as found.
   *
   * Both the copy and the box are measured against the line's own box rather
   * than the field's offsets: a todo puts a checkbox beside the field, and the
   * gap between them is not part of what offsetLeft counts.
   */
  function placeMark(area: HTMLTextAreaElement, offset: number, length: number) {
    const line = area.closest(".blk-line");
    if (!(line instanceof HTMLElement)) return;
    const origin = line.getBoundingClientRect();
    const frame = area.getBoundingClientRect();
    const style = window.getComputedStyle(area);
    const mirror = document.createElement("div");
    mirror.style.position = "absolute";
    mirror.style.top = `${frame.top - origin.top}px`;
    mirror.style.left = `${frame.left - origin.left}px`;
    mirror.style.visibility = "hidden";
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.wordWrap = "break-word";
    mirror.style.overflow = "hidden";
    for (const name of [
      "fontFamily",
      "fontSize",
      "fontWeight",
      "fontStyle",
      "letterSpacing",
      "lineHeight",
      "textTransform",
      "boxSizing",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "borderTopWidth",
      "borderRightWidth",
      "borderBottomWidth",
      "borderLeftWidth",
      "width",
    ] as const) {
      mirror.style[name] = style[name];
    }
    mirror.textContent = area.value.slice(0, offset);
    const run = document.createElement("span");
    // The box of an empty run has no place of its own: the caret needs one char.
    run.textContent = area.value.slice(offset, offset + length) || " ";
    mirror.append(run);
    line.append(mirror);
    const box = run.getBoundingClientRect();
    const left = box.left - origin.left;
    const top = box.top - origin.top;
    mirror.remove();
    const drawn = document.createElement("div");
    drawn.className = "find-mark";
    drawn.style.left = `${left}px`;
    drawn.style.top = `${top}px`;
    drawn.style.width = `${box.width}px`;
    drawn.style.height = `${box.height}px`;
    line.append(drawn);
    mark = drawn;
  }

  /** selectStop puts the search on a match: the word is marked and brought into
   * view. focus selects the words too and hands the keyboard to the text, as a
   * search result from the dialog does; the find field keeps the keyboard
   * otherwise, and the mark is what shows where the match is. */
  function selectStop(stop: { block: number; item: number; offset: number }, length: number, focus: boolean) {
    const area = root.querySelector<HTMLTextAreaElement>(
      `textarea[data-block="${stop.block}"][data-item="${stop.item}"]`,
    );
    if (!area) return;
    mark?.remove();
    mark = null;
    if (focus) {
      area.focus();
      area.setSelectionRange(stop.offset, Math.min(stop.offset + length, area.value.length));
    } else {
      placeMark(area, stop.offset, length);
    }
    (mark ?? area).scrollIntoView({ block: "nearest" });
    searchPos = { block: blocks[stop.block]!.id, item: stop.item, offset: stop.offset };
  }

  /** stopAtLine maps a line of a note's file to the block and line that hold
   * it: a block takes as many file lines as it has items, and one file line
   * between two blocks holds ∞∞∞. */
  function stopAtLine(line: number): { block: number; item: number } | null {
    let at = line;
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
      const count = blocks[blockIndex]!.items.length;
      if (at < count) return { block: blockIndex, item: at };
      at -= count + 1;
    }
    return null;
  }

  function find(query: string, { caseSensitive, back }: FindOptions): FindResult {
    const hits: { block: number; item: number; offset: number }[] = [];
    blocks.forEach((block, blockIndex) => {
      block.items.forEach((item, itemIndex) => {
        if (item.kind !== "line") return;
        for (const offset of occurrences(item.text, query, caseSensitive)) hits.push({ block: blockIndex, item: itemIndex, offset });
      });
    });
    if (hits.length === 0) {
      searchPos = null;
      return { total: 0, index: -1 };
    }
    const anchor = searchPos;
    const current = anchor
      ? hits.findIndex(
          (hit) => blocks[hit.block]!.id === anchor.block && hit.item === anchor.item && hit.offset === anchor.offset,
        )
      : -1;
    const continuing = query === lastFind.query && caseSensitive === lastFind.caseSensitive;
    let index: number;
    if (current < 0) index = back ? hits.length - 1 : 0;
    else if (!continuing) index = current;
    else index = (current + (back ? hits.length - 1 : 1)) % hits.length;
    selectStop(hits[index]!, query.length, false);
    lastFind = { query, caseSensitive };
    return { total: hits.length, index };
  }

  function reveal(line: number, query: string, { caseSensitive }: { caseSensitive: boolean }) {
    const stop = stopAtLine(line);
    const item = stop ? blocks[stop.block]!.items[stop.item] : undefined;
    const offsets = item?.kind === "line" ? occurrences(item.text, query, caseSensitive) : [];
    if (stop && offsets.length > 0) {
      selectStop({ ...stop, offset: offsets[0]! }, query.length, true);
      lastFind = { query, caseSensitive };
      return;
    }
    // The line moved since the search read the file: the note is searched from
    // the top instead, so that the caret still lands on a match.
    clearFind();
    find(query, { caseSensitive, back: false });
  }

  function clearFind() {
    mark?.remove();
    mark = null;
    searchPos = null;
    lastFind = { query: "", caseSensitive: false };
  }

  function selectionText(): string {
    const active = document.activeElement;
    if (!(active instanceof HTMLTextAreaElement) || !root.contains(active)) return "";
    const text = active.value.slice(active.selectionStart, active.selectionEnd);
    return text.includes("\n") ? "" : text;
  }

  // ---- changes -----------------------------------------------------------

  /** toggleTodo turns the line under the caret into a todo, and back. Other
   * lines of the block are left alone. */
  function toggleTodo(blockIndex: number, itemIndex: number, area: HTMLTextAreaElement) {
    const item = blocks[blockIndex]?.items[itemIndex];
    if (!item || item.kind !== "line") return;
    const caret = area.selectionStart;
    beginStructuralChange();
    item.text = area.value;
    item.todo = !item.todo;
    item.done = false;
    render({ block: blockIndex, item: itemIndex, caret: { offset: caret } });
    options.onChange();
  }

  /** insertBlock adds a block below the caret's block, whatever the caret is
   * doing inside it, as ⌘↵ does. */
  function insertBlock(blockIndex: number) {
    beginStructuralChange();
    blocks.splice(blockIndex + 1, 0, emptyBlock());
    render({ block: blockIndex + 1, item: 0, caret: "start" });
    options.onChange();
  }

  /**
   * moveBlock puts the block at blockIndex one place up or down, with the caret
   * staying in it: the first block cannot move up, nor the last one down.
   */
  function moveBlock(blockIndex: number, step: -1 | 1, at: { item: number; caret: Caret }) {
    const to = blockIndex + step;
    if (to < 0 || to >= blocks.length) return;
    beginStructuralChange();
    const moved = blocks.splice(blockIndex, 1)[0]!;
    blocks.splice(to, 0, moved);
    render({ block: to, item: at.item, caret: at.caret });
    options.onChange();
  }

  /** blockStep reads the move shortcuts from the settings: -1 for up, 1 for
   * down, 0 for a key that is neither. A shortcut without a modifier is
   * ignored there, so that plain arrows keep walking the lines. */
  function blockStep(event: KeyboardEvent): -1 | 0 | 1 {
    const pressed = accelFromEvent(event);
    if (!pressed) return 0;
    const accel = canonical(pressed);
    if (!hasModifier(accel)) return 0;
    if (accel === canonical(options.binding("moveBlockUp"))) return -1;
    if (accel === canonical(options.binding("moveBlockDown"))) return 1;
    return 0;
  }

  /** splitLine breaks the line at the caret: the text after it becomes a plain
   * line below, which is what Enter gives. */
  function splitLine(blockIndex: number, itemIndex: number, area: HTMLTextAreaElement) {
    const item = blocks[blockIndex]?.items[itemIndex];
    if (!item || item.kind !== "line") return;
    beginStructuralChange();
    const after = item.text.slice(area.selectionEnd);
    item.text = item.text.slice(0, area.selectionStart);
    blocks[blockIndex]!.items.splice(itemIndex + 1, 0, plainLine(after));
    render({ block: blockIndex, item: itemIndex + 1, caret: "start" });
    options.onChange();
  }

  /**
   * recognizeLine rewrites an edited line into what its markdown stands for,
   * as the note file reads it: "- [ ] " at the front makes a todo, a new line
   * makes another line, a path makes a picture. It runs on what the user types
   * and on what they paste, so a block of copied markdown renders at once
   * instead of waiting for the note to be read again.
   */
  function recognizeLine(blockIndex: number, itemIndex: number, text: string): boolean {
    const lines = text.split("\n");
    if (lines.length === 1 && !TODO_LINE.test(text) && !IMAGE_LINE.test(text.trim())) return false;
    const block = blocks[blockIndex];
    const item = block?.items[itemIndex];
    if (!block || !item || item.kind !== "line") return false;
    beginStructuralChange();
    const items = itemsFromLines(lines);
    // A picture cannot hold the caret: one that ends the text gets the empty
    // line under it that a pasted picture leaves too.
    if (items[items.length - 1]!.kind === "image") items.push(plainLine());
    block.items.splice(itemIndex, 1, ...items);
    selected = new Set();
    render({ block: blockIndex, item: itemIndex + items.length - 1, caret: "end" });
    options.onChange();
    return true;
  }

  function backspaceAtStart(blockIndex: number, itemIndex: number, area: HTMLTextAreaElement) {
    const block = blocks[blockIndex];
    const item = block?.items[itemIndex];
    if (!block || !item || item.kind !== "line") return;

    // An empty line under a checkbox drops the checkbox first.
    if (item.todo && item.text === "") {
      beginStructuralChange();
      item.todo = false;
      item.done = false;
      render({ block: blockIndex, item: itemIndex, caret: "start" });
      options.onChange();
      return;
    }

    const previous = neighbour(blockIndex, itemIndex, -1);
    if (!previous) return;
    const previousItem = blocks[previous.block]!.items[previous.item]!;
    if (previousItem.kind !== "line") return;

    beginStructuralChange();
    const caret = previousItem.text.length;
    const text = item.text;
    previousItem.text = text === "" ? previousItem.text : `${previousItem.text}${text}`;
    const owner = blocks[blockIndex]!;
    owner.items.splice(itemIndex, 1);
    if (owner.items.length === 0) {
      if (blocks.length > 1) blocks.splice(blockIndex, 1);
      else owner.items.push(plainLine());
    }
    render({
      block: previous.block,
      item: previous.item,
      caret: { offset: caret },
    });
    options.onChange();
  }

  /** mergeNext pulls the next line into this one, as Delete at the end of a
   * line does in an editor. */
  function mergeNext(blockIndex: number, itemIndex: number, area: HTMLTextAreaElement) {
    const item = blocks[blockIndex]?.items[itemIndex];
    const next = neighbour(blockIndex, itemIndex, 1);
    if (!item || item.kind !== "line" || !next) return;
    const nextItem = blocks[next.block]!.items[next.item]!;
    if (nextItem.kind !== "line") return;
    const caret = area.selectionStart;
    beginStructuralChange();
    item.text = `${item.text}${nextItem.text}`;
    const owner = blocks[next.block]!;
    owner.items.splice(next.item, 1);
    if (owner.items.length === 0) {
      if (blocks.length > 1) blocks.splice(next.block, 1);
      else owner.items.push(plainLine());
    }
    render({ block: blockIndex, item: itemIndex, caret: { offset: caret } });
    options.onChange();
  }

  function deleteSelected() {
    if (selected.size === 0) return;
    beginStructuralChange();
    blocks = blocks.filter((block) => !selected.has(block.id));
    if (blocks.length === 0) blocks.push(emptyBlock());
    selected = new Set();
    render({ block: 0, item: 0, caret: "end" });
    options.onChange();
  }

  function onPaste(event: ClipboardEvent, blockIndex: number, itemIndex: number, item: Item) {
    const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    const area = event.currentTarget;
    const from = area instanceof HTMLTextAreaElement ? area.selectionStart : 0;
    const to = area instanceof HTMLTextAreaElement ? area.selectionEnd : 0;
    void addPictures(blockIndex, itemIndex, files, from, to);
  }

  /**
   * addPictures puts the pictures under the line the caret is in and leaves an
   * empty line below them, where the caret waits: whatever followed the caret
   * moves under the pictures. A bare line that the caret sits in holds the
   * pictures itself, so that no blank line is left above them; a todo line
   * keeps its checkbox and the pictures go under it.
   */
  async function addPictures(blockIndex: number, itemIndex: number, files: File[], from: number, to: number) {
    const block = blocks[blockIndex];
    const item = block?.items[itemIndex];
    if (!block || !item || item.kind !== "line") return;
    const paths: string[] = [];
    for (const file of files) {
      const path = await options.onImage(file);
      if (path) paths.push(path);
    }
    if (paths.length === 0) return;

    beginStructuralChange();
    const pictures: Item[] = paths.map((path) => ({ kind: "image", path }));
    const wait = plainLine(item.text.slice(to));
    if (item.text === "" && !item.todo) {
      block.items.splice(itemIndex, 1, ...pictures, wait);
      render({ block: blockIndex, item: itemIndex + pictures.length, caret: "start" });
    } else {
      item.text = item.text.slice(0, from);
      block.items.splice(itemIndex + 1, 0, ...pictures, wait);
      render({ block: blockIndex, item: itemIndex + pictures.length + 1, caret: "start" });
    }
    options.onChange();
  }

  // ---- keyboard ----------------------------------------------------------

  function onRowKeyDown(event: KeyboardEvent) {
    const area = event.target;
    if (!(area instanceof HTMLTextAreaElement)) return;
    // The Enter that picks a candidate, and every key down the input method
    // took, leave the lines as they are.
    if (imeBusy(event)) return;
    const blockIndex = Number(area.dataset.block ?? 0);
    const itemIndex = Number(area.dataset.item ?? 0);
    const meta = event.metaKey || event.ctrlKey;

    if (meta && event.key.toLowerCase() === "l") {
      event.preventDefault();
      toggleTodo(blockIndex, itemIndex, area);
      return;
    }
    if (!meta && isEnterKey(event)) {
      event.preventDefault();
      splitLine(blockIndex, itemIndex, area);
      return;
    }
    const step = blockStep(event);
    if (step !== 0) {
      // The block itself moves, and the caret moves with it.
      event.preventDefault();
      moveBlock(blockIndex, step, { item: itemIndex, caret: { offset: area.selectionStart } });
      return;
    }
    if (event.key === "Backspace" && area.selectionStart === 0 && area.selectionEnd === 0) {
      event.preventDefault();
      backspaceAtStart(blockIndex, itemIndex, area);
      return;
    }
    if (event.key === "Delete" && area.selectionStart === area.value.length && area.selectionEnd === area.value.length) {
      event.preventDefault();
      mergeNext(blockIndex, itemIndex, area);
      return;
    }
    // The arrows walk the items of the note in order, pictures included: a
    // picture stops the caret for a moment, and Enter writes under it.
    const column = area.selectionStart;
    if (event.key === "ArrowUp") {
      const previous = stopAt(blockIndex, itemIndex, -1);
      if (previous) {
        event.preventDefault();
        focusRun({ ...previous, caret: { offset: column } });
      }
      return;
    }
    if (event.key === "ArrowDown") {
      const next = stopAt(blockIndex, itemIndex, 1);
      if (next) {
        event.preventDefault();
        focusRun({ ...next, caret: { offset: column } });
      }
    }
  }

  /** rowIndexAt returns the block an event came from, or -1. */
  function rowIndexAt(target: EventTarget | null): number {
    if (!(target instanceof HTMLElement)) return -1;
    const row = target.closest(".blk");
    return row instanceof HTMLElement ? [...root.children].indexOf(row) : -1;
  }

  function onWindowKeyDown(event: KeyboardEvent) {
    const target = event.target;
    const inside = target instanceof Node && root.contains(target);
    const meta = event.metaKey || event.ctrlKey;

    // A block selection outlives the focus ⌘A takes away, so these do not
    // depend on the caret being in the editor.
    if (selected.size > 0) {
      if (!meta && (event.key === "Backspace" || event.key === "Delete")) {
        event.preventDefault();
        event.stopPropagation();
        deleteSelected();
        return;
      }
      if (meta && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
    }

    if (meta && isEnterKey(event) && (inside || selected.size > 0)) {
      // A block under the current one, never a split of its text.
      event.preventDefault();
      event.stopPropagation();
      const at = rowIndexAt(target);
      insertBlock(at >= 0 ? at : blocks.length - 1);
      options.onStatus?.(`Block ${blocks.length}`);
      return;
    }

    if (!inside) return;
    if (!meta) return;
    const key = event.key.toLowerCase();
    if (key === "a" && !event.shiftKey && !event.altKey) {
      // The first press selects the block the caret is in, the next one the
      // whole note: a block is the unit the note is written and copied in, and
      // the text of one line is what ordinary text selection is for. Never the
      // page: the sidebar and the title stay out.
      event.preventDefault();
      event.stopPropagation();
      if (selected.size >= blocks.length) return;
      const row = rowIndexAt(target);
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      if (selected.size === 0 && row >= 0) {
        selected = new Set([blocks[row]!.id]);
        options.onStatus?.("Block selected");
      } else {
        selected = new Set(blocks.map((block) => block.id));
        options.onStatus?.("Note selected");
      }
      paintSelection();
      return;
    }
    if (key === "z") {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) redo();
      else undo();
    }
  }

  /** absolute names a picture where it is on disk, for text that leaves the
   * app: the note file keeps the path relative to the data directory, and what
   * the user pastes elsewhere is a whole path anything can open. */
  function absolute(path: string): string {
    return path.startsWith(IMAGE_DIR) ? `${options.imagesDir}/${path.slice(IMAGE_DIR.length)}` : path;
  }

  /** focusedPicturePath names the picture that holds the keyboard where it is
   * on disk, the same whole path a copy of the note hands out. */
  function focusedPicturePath(): string | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    const wrap = active.closest(".blk-pic");
    return wrap instanceof HTMLElement ? (wrap.dataset.path ?? null) : null;
  }

  function onCopy(event: ClipboardEvent) {
    const path = focusedPicturePath();
    if (path) {
      event.clipboardData?.setData("text/plain", path);
      event.preventDefault();
      options.onStatus?.("Picture path copied");
      return;
    }
    if (selected.size === 0) return;
    const text = blocks
      .filter((block) => selected.has(block.id))
      .map((block) =>
        blockLines(block)
          .map((line) => (line.startsWith(IMAGE_DIR) ? absolute(line) : line))
          .join("\n"),
      )
      .join("\n\n");
    event.clipboardData?.setData("text/plain", text);
    event.preventDefault();
  }

  function onCut(event: ClipboardEvent) {
    if (selected.size === 0) return;
    onCopy(event);
    if (event.defaultPrevented) cutSelected();
  }

  /**
   * cutSelected copies the selected blocks out and empties the first of them in
   * place, where the caret then waits: cutting a block leaves the block the
   * user was writing in, as cutting text leaves an empty line. Deleting a
   * selection is the action that takes blocks out of the note.
   */
  function cutSelected() {
    const index = blocks.findIndex((block) => selected.has(block.id));
    if (index < 0) return;
    beginStructuralChange();
    blocks[index]!.items = [plainLine()];
    blocks = blocks.filter((block, at) => at === index || !selected.has(block.id));
    selected = new Set();
    render({ block: index, item: 0, caret: "end" });
    options.onChange();
  }

  root.addEventListener("keydown", onRowKeyDown);
  root.addEventListener("mousedown", (event) => {
    if ((event.target as HTMLElement).closest(".blk-pic")) return;
    if (selected.size > 0) {
      selected = new Set();
      paintSelection();
    }
  });
  window.addEventListener("keydown", onWindowKeyDown, true);
  document.addEventListener("copy", onCopy, true);
  document.addEventListener("cut", onCut, true);

  render();

  return {
    focus: () => {
      const index = blocks.findIndex((block) => block.id === lastFocusID);
      focusRun({ block: index >= 0 ? index : 0, item: 0, caret: "end" });
    },
    text: noteText,
    find,
    reveal,
    clearFind,
    selectionText,
    destroy: () => {
      window.removeEventListener("keydown", onWindowKeyDown, true);
      document.removeEventListener("copy", onCopy, true);
      document.removeEventListener("cut", onCut, true);
      root.remove();
    },
  };
}
