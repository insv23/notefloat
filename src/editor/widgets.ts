// What the note's text is drawn as. A line is text in the document like any
// other; these decorations are the only thing that turns a todo prefix, a
// picture path and a ∞∞∞ line into what the user sees. The document stays the
// note file's text, so nothing has to be written back.
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { EditorSelection, Facet, RangeSet, StateEffect, StateField, type EditorState, type Range, type Text } from "@codemirror/state";
import { blockRanges, flipTodoCheck, lineKind } from "./model";

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

/** setDoneBlocks replaces which blocks of the note the user finished. */
export const setDoneBlocks = StateEffect.define<boolean[]>();

/** doneFlags draws a finished block dim: every line of it, pictures included.
 * The flags name the blocks by their place in the note, so the whole block fades
 * and the caret still moves line by line. */
export function doneFlags(doc: Text, done: boolean[]): DecorationSet {
  const marks: Range<Decoration>[] = [];
  const ranges = blockRanges(doc);
  for (let index = 0; index < ranges.length; index++) {
    if (!done[index]) continue;
    const range = ranges[index]!;
    const first = doc.lineAt(range.from).number;
    const last = doc.lineAt(range.to).number;
    for (let number = first; number <= last; number++) {
      marks.push(Decoration.line({ class: "cm-block-done" }).range(doc.line(number).from));
    }
  }
  return Decoration.set(marks, true);
}

/** DoneView is which blocks are finished and the dimming they draw. */
type DoneView = { done: boolean[]; decorations: DecorationSet };

/** doneBlocks is the finish state of the note's blocks, one flag per block in
 * the note's order. A note edited outside the app can come back with more or
 * fewer blocks: the flags that still have a block keep their place from the top,
 * and the rest start open. */
export const doneBlocks = StateField.define<DoneView>({
  create: () => ({ done: [], decorations: Decoration.none }),
  update(value, transaction) {
    let flags = value.done;
    for (const effect of transaction.effects) {
      if (effect.is(setDoneBlocks)) flags = effect.value;
    }
    const count = blockRanges(transaction.state.doc).length;
    if (flags.length !== count) flags = Array.from({ length: count }, (_unused, at) => flags[at] ?? false);
    if (flags === value.done && !transaction.docChanged) return value;
    return { done: flags, decorations: doneFlags(transaction.state.doc, flags) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/** doneOf reads which blocks the state holds as finished. */
export function doneOf(state: EditorState): boolean[] {
  return state.field(doneBlocks).done;
}
