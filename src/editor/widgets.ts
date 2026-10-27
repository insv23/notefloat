// What the note's text is drawn as. A line is text in the document like any
// other; these decorations are the only thing that turns a todo prefix, a
// picture path and a ∞∞∞ line into what the user sees. The document stays the
// note file's text, so nothing has to be written back.
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { EditorSelection, Facet, RangeSet, StateEffect, StateField, type EditorState, type Range, type Text } from "@codemirror/state";
import { blocks, flipTodoCheck, lineKind } from "./model";

/** PictureSource turns the path a note holds into what the page loads and what
 * leaves the app when the picture's path is copied. */
export type PictureSource = { url: (path: string) => string; whole: (path: string) => string };

export const pictureSource = Facet.define<PictureSource, PictureSource>({
  combine: (values) => values[0]!,
});

/** TodoWidget is the checkbox a "- [ ] " prefix becomes. */
class TodoWidget extends WidgetType {
  constructor(readonly done: boolean) {
    super();
  }

  eq(other: TodoWidget) {
    return other.done === this.done;
  }

  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-todo-check";
    box.checked = this.done;
    box.setAttribute("aria-label", this.done ? "Mark as not done" : "Mark as done");
    // The press must not take the caret out of the line beside it.
    box.addEventListener("mousedown", (event) => event.preventDefault());
    box.addEventListener("change", () => {
      let pos: number;
      try {
        pos = view.posAtDOM(box);
      } catch {
        return;
      }
      const line = view.state.doc.lineAt(pos);
      const kind = lineKind(line.text);
      if (kind.kind !== "todo") return;
      const prefix = line.text.slice(0, kind.prefix);
      view.dispatch({ changes: { from: line.from, to: line.from + kind.prefix, insert: flipTodoCheck(prefix) } });
      view.focus();
    });
    return box;
  }

  ignoreEvent() {
    return false;
  }
}

/** PictureWidget draws a picture line as the picture itself. */
class PictureWidget extends WidgetType {
  constructor(
    readonly path: string,
    readonly url: string,
    readonly whole: string,
  ) {
    super();
  }

  eq(other: PictureWidget) {
    return other.path === this.path;
  }

  toDOM(view: EditorView) {
    // The picture is the widget itself, with no box of its own around it: a box
    // would hug the line's width rather than the picture's, and the caret after
    // the picture would stand at the end of the line instead of at its edge.
    const img = document.createElement("img");
    img.className = "cm-picture";
    img.src = this.url;
    img.alt = this.path.split("/").pop() ?? "Picture";
    img.title = this.whole;
    img.draggable = false;
    // A press puts the caret at the nearer end of the picture, before or after
    // the path: the two places a delete acts on the picture from.
    img.addEventListener("mousedown", (event) => {
      event.preventDefault();
      let anchor: number;
      try {
        anchor = view.posAtDOM(img);
      } catch {
        return;
      }
      const line = view.state.doc.lineAt(anchor);
      const box = img.getBoundingClientRect();
      const at = event.clientX < box.left + box.width / 2 ? line.from : line.to;
      view.dispatch({ selection: EditorSelection.cursor(at) });
      view.focus();
    });
    return img;
  }

  ignoreEvent() {
    return true;
  }

  get estimatedHeight() {
    return 200;
  }
}

/** HairlineWidget is the line between two blocks. It is a block widget: the
 * ∞∞∞ line it replaces, and the break after it, are not lines of the note any
 * more, so there is no row between two blocks for the caret to stop in. */
class HairlineWidget extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    const line = document.createElement("div");
    line.className = "cm-divider";
    return line;
  }

  // A press on the hairline is the editor's own: it puts the caret in the block
  // beside it, rather than being swallowed by the widget.
  ignoreEvent() {
    return false;
  }
}

/** NoteView is what the editor needs to draw the note and to know which parts
 * of it the caret steps over as a whole. */
type NoteView = { decorations: DecorationSet; atomic: RangeSet<Decoration> };

function note(state: EditorState): NoteView {
  const ranges: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const doc = state.doc;
  const source = state.facet(pictureSource);
  /** replaced hides a stretch of text behind a widget, and the caret steps over
   * it as one thing: the todo prefix, a picture's path, a separator. */
  const replaced = (from: number, to: number, widget: WidgetType) => {
    const decoration = Decoration.replace({ widget });
    ranges.push(decoration.range(from, to));
    if (to > from) atomic.push(decoration.range(from, to));
  };
  for (let number = 1; number <= doc.lines; number++) {
    const line = doc.line(number);
    const kind = lineKind(line.text);
    if (kind.kind === "separator") {
      // Only the separator's own text becomes the hairline: its two line breaks
      // stay in the document, which is what a new line pressed at the end of a
      // block is inserted next to. The caret still steps over the whole
      // separator, breaks included, as one thing.
      ranges.push(Decoration.replace({ block: true, inclusive: true, widget: new HairlineWidget() }).range(line.from, line.to));
      const lead = Math.max(0, line.from - 1);
      const trail = Math.min(doc.length, line.to + 1);
      atomic.push(Decoration.replace({}).range(lead, trail));
      continue;
    }
    if (kind.kind === "picture") {
      // The line is marked so that it can be kept one visual row at any width:
      // a picture that wrapped would leave the caret on a row of its own.
      ranges.push(Decoration.line({ class: "cm-picture-line" }).range(line.from));
      replaced(line.from, line.to, new PictureWidget(kind.path, source.url(kind.path), source.whole(kind.path)));
      continue;
    }
    if (kind.kind === "todo") {
      replaced(line.from, line.from + kind.prefix, new TodoWidget(kind.done));
    }
  }
  return { decorations: Decoration.set(ranges, true), atomic: RangeSet.of(atomic, true) };
}

/** noteView draws the note's file text as the note: todos, pictures and the
 * line between blocks. It is a state field, not a view plugin: what the caret
 * steps over has to be known to the state, not only to the drawing. */
export const noteView = StateField.define<NoteView>({
  create: (state) => note(state),
  update(value, transaction) {
    if (!transaction.docChanged) return value;
    return note(transaction.state);
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).atomic),
  ],
});

/** markLongTokens marks the stretches of a line a reader would not expect to be
 * one word: a path, a link, a hash, 24 characters or more with no space in it.
 * The browser holds such a run whole and pushes it to the next line even when the
 * line it left had room, so each one is marked to break anywhere and fill the
 * line it starts on. */
function markLongTokens(doc: Text): DecorationSet {
  const marks: Range<Decoration>[] = [];
  for (let number = 1; number <= doc.lines; number++) {
    const line = doc.line(number);
    const run = /\S{24,}/gu;
    for (let found = run.exec(line.text); found; found = run.exec(line.text)) {
      const from = line.from + found.index;
      marks.push(Decoration.mark({ class: "cm-long-token" }).range(from, from + found[0].length));
    }
  }
  return Decoration.set(marks, true);
}

/** longTokens lets a long run break inside itself, so that prose keeps breaking
 * at its spaces while a path or a link fills the line it starts on. */
export const longTokens = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = markLongTokens(view.state.doc);
    }

    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = markLongTokens(update.state.doc);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** setFoldLimit and setFilter carry the reading settings into the note: how many
 * lines of a folded block stay in view, and whether finished blocks are drawn at
 * all. */
export const setFoldLimit = StateEffect.define<number>();
export const setFilter = StateEffect.define<BlockFilter>();

/** BlockFilter is which blocks the note draws: all of them, or the ones the user
 * has not finished. */
export type BlockFilter = "all" | "unfinished";

/** FoldView is a folded block drawn as a reading view of itself: the text of the
 * block written out the way the note writes it, which the browser lays out and
 * cuts at the fold height. The browser owns the wrapping, so the block stays as
 * many rows tall as the setting asks for whatever the window's width. */
class FoldView extends WidgetType {
  constructor(
    readonly text: string,
    readonly done: boolean,
    readonly limit: number,
    readonly source: PictureSource,
  ) {
    super();
  }

  eq(other: FoldView) {
    return other.text === this.text && other.done === this.done && other.limit === this.limit;
  }

  toDOM() {
    const box = document.createElement("div");
    box.className = this.done ? "cm-fold-preview cm-block-done" : "cm-fold-preview";
    box.style.setProperty("--fold-lines", String(this.limit));
    // The words are cut by their own height, and the frost is their sibling: a
    // mask on the element that holds the words would fall on the frost as well.
    const words = document.createElement("div");
    words.className = "cm-fold-words";
    words.append(...this.rows());
    box.append(words);
    return box;
  }

  /** rows is the block's lines as the note draws them: a todo's box and its
   * text, a picture, a line of prose, and the breaks between them. */
  private rows(): (string | HTMLElement)[] {
    const rows: (string | HTMLElement)[] = [];
    this.text.split("\n").forEach((text, index) => {
      if (index > 0) rows.push("\n");
      const kind = lineKind(text);
      if (kind.kind === "picture") {
        const picture = document.createElement("img");
        picture.className = "cm-picture";
        picture.src = this.source.url(kind.path);
        picture.draggable = false;
        rows.push(picture);
        return;
      }
      if (kind.kind === "todo") {
        const box = document.createElement("input");
        box.type = "checkbox";
        box.className = "cm-todo-check";
        box.checked = kind.done;
        box.tabIndex = -1;
        rows.push(box, text.slice(kind.prefix));
        return;
      }
      rows.push(text);
    });
    return rows;
  }

  // A press on the block is the editor's own: it puts the caret in the block,
  // which draws it whole again.
  ignoreEvent() {
    return false;
  }
}

/** BlockView is what the note's blocks are drawn as now, and the stretches the
 * caret steps over whole. */
type BlockView = { limit: number; filter: BlockFilter; decorations: DecorationSet; hidden: DecorationSet };

/** buildBlocks draws the note's blocks from the two marks a block can carry,
 * which are drawn apart from each other. The filter drops finished blocks; a
 * folded block is drawn as the reading view of itself; and a finished block is
 * dim however it is drawn — under a fold or open, the block that is done reads as
 * done. The one block never drawn by these rules is the block the caret stands
 * in: no mark and no setting may take the caret's own text away from it. */
function buildBlocks(state: EditorState, limit: number, filter: BlockFilter): BlockView {
  const doc = state.doc;
  const source = state.facet(pictureSource);
  const all: Range<Decoration>[] = [];
  const hidden: Range<Decoration>[] = [];
  /** keepsAway hides a run of whole lines, and keeps the caret out of it. */
  const keepsAway = (from: number, to: number) => {
    const away = Decoration.replace({ block: true });
    all.push(away.range(from, to));
    hidden.push(away.range(from, to));
  };
  /** touched tells whether the caret or a selection reaches into a stretch, which
   * is what keeps a block from being dropped out from under the caret. */
  const touched = (from: number, to: number) =>
    state.selection.ranges.some((range) => range.from <= to && range.to >= from);

  for (const block of blocks(doc)) {
    const closesAt = block.separator === null ? block.to : doc.lineAt(block.separator).to;
    // The filter takes a finished block away whole, its hairline included.
    if (block.done && filter === "unfinished" && !touched(block.from, closesAt)) {
      keepsAway(block.from, closesAt);
      continue;
    }
    // A folded block is the note read back, and the text under the fold comes
    // back the moment the caret steps into it.
    if (block.folded && !touched(block.from, block.to)) {
      const text = doc.sliceString(block.from, block.to);
      all.push(Decoration.replace({ block: true, widget: new FoldView(text, block.done, limit, source) }).range(block.from, block.to));
      continue;
    }
    // What is left is the block drawn as the note writes it: folded or open, a
    // finished block keeps the dim that says so.
    if (!block.done) continue;
    for (let number = doc.lineAt(block.from).number; number <= doc.lineAt(block.to).number; number++) {
      all.push(Decoration.line({ class: "cm-block-done" }).range(doc.line(number).from));
    }
  }
  return { limit, filter, decorations: Decoration.set(all, true), hidden: Decoration.set(hidden, true) };
}

/** openBlocks is the view a note opens with: the fold limit the settings hold,
 * and every block drawn. */
export function openBlocks(state: EditorState, limit: number): BlockView {
  return buildBlocks(state, limit, "all");
}

/** blockView draws the note's blocks as the reading settings say, and re-reads
 * them from the text on every change: the marks are part of the note, so there is
 * no second copy of them to keep in step. */
export const blockView = StateField.define<BlockView>({
  create: (state) => buildBlocks(state, 4, "all"),
  update(value, transaction) {
    let limit = value.limit;
    let filter = value.filter;
    for (const effect of transaction.effects) {
      if (effect.is(setFoldLimit)) limit = effect.value;
      else if (effect.is(setFilter)) filter = effect.value;
    }
    if (!transaction.docChanged && !transaction.selection && limit === value.limit && filter === value.filter) {
      return value;
    }
    return buildBlocks(transaction.state, limit, filter);
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).hidden),
  ],
});
