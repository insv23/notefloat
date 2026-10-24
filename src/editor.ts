// The editor: a list of blocks, each rendered as plain DOM. A block is a group
// of lines with a hairline between it and the next block; a line is either plain
// text or a todo, and a todo's checkbox belongs to that one line. Pictures take
// their place among the lines. The note file keeps the same shape: lines,
// pictures as their paths, `- [ ] ` in front of a todo line, and a line holding
// ∞∞∞ between blocks. The editor never shows ∞∞∞.
const IMAGE_SCHEME = "notefloat-img";
const TODO_LINE = /^\s*- \[([ xX])\] ?(.*)$/;
const IMAGE_LINE = /^(\/.*\.(?:png|jpe?g|gif|webp|heic))\s*$/;
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

function blockFromLines(lines: string[]): Block {
  const items: Item[] = [];
  for (const line of lines) {
    const path = IMAGE_LINE.exec(line.trim());
    if (path) {
      items.push({ kind: "image", path: path[1]! });
      continue;
    }
    const todo = TODO_LINE.exec(line);
    if (todo) items.push({ kind: "line", text: todo[2] ?? "", todo: true, done: todo[1] !== " " });
    else items.push(plainLine(line));
  }
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
  destroy: () => void;
};

export type EditorOptions = {
  doc: string;
  imagesDir: string;
  onChange: () => void;
  /** A short word in the title bar, so that what the keyboard did is visible. */
  onStatus?: (text: string) => void;
  /** Stores a pasted picture and returns its path, or null to insert nothing. */
  onImage: (file: File) => Promise<string | null>;
};

/** createEditor mounts the notes editor of a buffer. */
export function createEditor(parent: HTMLElement, options: EditorOptions): NoteEditor {
  let blocks = parseNote(options.doc);
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
    blocks = parseNote(note);
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

  function imageURL(path: string): string {
    const prefix = `${options.imagesDir}/`;
    return path.startsWith(prefix) ? `${IMAGE_SCHEME}://localhost/${path.slice(prefix.length)}` : "";
  }

  function autosize(area: HTMLTextAreaElement) {
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight}px`;
  }

  function focusRun(at: { block: number; item: number; caret: Caret }) {
    const blockIndex = Math.min(Math.max(at.block, 0), blocks.length - 1);
    const block = blocks[blockIndex];
    if (!block) return;
    let item = at.item;
    if (block.items[item]?.kind !== "line") {
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

  function picture(block: Block, blockIndex: number, path: string, itemIndex: number): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "blk-pic";
    const img = document.createElement("img");
    img.src = imageURL(path);
    img.alt = path.split("/").pop() ?? "图片";
    img.title = path;
    img.loading = "lazy";
    const remove = document.createElement("button");
    remove.className = "blk-pic-remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "删除这张图片";
    remove.addEventListener("mousedown", (event) => event.preventDefault());
    remove.addEventListener("click", () => {
      beginStructuralChange();
      block.items.splice(itemIndex, 1);
      if (block.items.length === 0) block.items.push(plainLine());
      const at = block.items.findIndex((item) => item.kind === "line");
      render({ block: blockIndex, item: Math.max(0, at), caret: "end" });
      options.onChange();
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
        box.setAttribute("aria-label", item.done ? "标记为未完成" : "标记为完成");
        // The press must not take the caret out of the text beside it.
        box.addEventListener("mousedown", (event) => event.preventDefault());
        box.addEventListener("change", () => {
          beginStructuralChange();
          item.done = box.checked;
          line.classList.toggle("done", item.done);
          box.setAttribute("aria-label", item.done ? "标记为未完成" : "标记为完成");
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
        area.placeholder = "写点什么……⌘L 待办，⌘↵ 新建块，⌘B 侧边栏，Esc 收起";
      }
      area.addEventListener("input", () => {
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
    for (const area of root.querySelectorAll("textarea")) autosize(area);
    if (focus) focusRun(focus);
  }

  function paintSelection() {
    for (const child of root.children) {
      if (child instanceof HTMLElement) child.classList.toggle("selected", selected.has(child.dataset.id ?? ""));
    }
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
   * moves under the pictures.
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
    const rest = item.text.slice(to);
    item.text = item.text.slice(0, from);
    const added: Item[] = paths.map((path) => ({ kind: "image", path }));
    added.push(plainLine(rest));
    block.items.splice(itemIndex + 1, 0, ...added);
    render({ block: blockIndex, item: itemIndex + added.length, caret: "start" });
    options.onChange();
  }

  // ---- keyboard ----------------------------------------------------------

  function onRowKeyDown(event: KeyboardEvent) {
    const area = event.target;
    if (!(area instanceof HTMLTextAreaElement)) return;
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
    // The arrows move between lines, so a picture between them is stepped over
    // rather than landed on.
    const column = area.selectionStart;
    if (event.key === "ArrowUp") {
      const previous = neighbour(blockIndex, itemIndex, -1);
      if (previous) {
        event.preventDefault();
        focusRun({ ...previous, caret: { offset: column } });
      }
      return;
    }
    if (event.key === "ArrowDown") {
      const next = neighbour(blockIndex, itemIndex, 1);
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
      options.onStatus?.(`新块 #${blocks.length}`);
      return;
    }

    if (!inside) return;
    if (!meta) return;
    const key = event.key.toLowerCase();
    if (key === "a" && !event.shiftKey && !event.altKey) {
      // The first press selects the text of the line the caret is in, the next
      // one the whole note. Never the page: the sidebar and the title stay out.
      event.preventDefault();
      event.stopPropagation();
      if (selected.size > 0) return;
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement && root.contains(active)) {
        const whole = active.selectionStart === 0 && active.selectionEnd === active.value.length;
        if (!whole && active.value.length > 0) {
          active.setSelectionRange(0, active.value.length);
          return;
        }
      }
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      selected = new Set(blocks.map((block) => block.id));
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

  function onCopy(event: ClipboardEvent) {
    if (selected.size === 0) return;
    const text = blocks
      .filter((block) => selected.has(block.id))
      .map((block) => blockLines(block).join("\n"))
      .join("\n\n");
    event.clipboardData?.setData("text/plain", text);
    event.preventDefault();
  }

  function onCut(event: ClipboardEvent) {
    if (selected.size === 0) return;
    onCopy(event);
    if (event.defaultPrevented) deleteSelected();
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
    destroy: () => {
      window.removeEventListener("keydown", onWindowKeyDown, true);
      document.removeEventListener("copy", onCopy, true);
      document.removeEventListener("cut", onCut, true);
      root.remove();
    },
  };
}
