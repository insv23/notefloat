// The note editor. The document is the note's file text — blocks separated by
// ∞∞∞ lines, todo lines with their prefix, pictures as their path — and
// CodeMirror draws that text as the note (see ./widgets.ts) and moves one
// selection over it. Nothing here renders a line: the caret is the editor's own
// selection, so a line is never an element of its own that could lose it.
import { EditorSelection, EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, placeholder, type DecorationSet } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { absolute, imageURL } from "../paths";
import { formatAccel } from "../shortcuts";
import { clearPicture, picturesKept } from "./commands";
import { noteKeymap } from "./keymap";
import { picturePath } from "./model";
import { doneBlocks, doneFlags, longTokens, noteView, pictureSource } from "./widgets";

export type FindOptions = { caseSensitive: boolean; back: boolean };
export type FindResult = { total: number; index: number };

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
   * note's file, so that the caret lands where the search's result points.
   */
  reveal: (line: number, query: string, options: { caseSensitive: boolean }) => void;
  /** clearFind drops the place a search left, so the next one starts afresh. */
  clearFind: () => void;
  /** selectionText is the text the caret holds selected, or the empty string. */
  selectionText: () => string;
  /** position is where the caret is, as an offset into the note's text. */
  position: () => number;
  destroy: () => void;
};

export type EditorOptions = {
  doc: string;
  /** at is where the caret goes: the place it stood when the note was last
   * written, so that opening a long note comes back to it rather than to the
   * top. */
  at: number;
  /** done is which blocks of the note were finished when it was opened, one flag
   * per block in the note's order. */
  done: boolean[];
  imagesDir: string;
  onChange: () => void;
  /** onDone carries the finished blocks back, to be kept with the note. */
  onDone: (done: boolean[]) => void;
  /** A short word in the title bar, so that what the keyboard did is visible. */
  onStatus?: (text: string) => void;
  /** Stores a pasted picture and returns its path, or null to insert nothing. */
  onImage: (file: File) => Promise<string | null>;
  /** binding is the accelerator the settings hold for an action, read on the
   * key press: the shortcut list changes while the editor stays. */
  binding: (action: string) => string;
};

/** hintText is what an empty note shows, on one line: where to type, and the key
 * that says a note is made of blocks. The rest of the keys live in the settings,
 * where they can be read again; this line disappears at the first keystroke. */
function hintText(binding: EditorOptions["binding"]) {
  const block = formatAccel(binding("addBlockBelow"));
  return block ? `Type here · ${block} new block` : "Type here";
}

/** theMatch is the word a search stopped on, drawn over the text. */
const setMatch = StateEffect.define<{ from: number; to: number } | null>();

const matchField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(mark, transaction) {
    let next = mark.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setMatch)) continue;
      next = effect.value
        ? Decoration.set([Decoration.mark({ class: "cm-find-match" }).range(effect.value.from, effect.value.to)])
        : Decoration.none;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** matchesIn returns where needle starts in text, in document offsets. */
function matchesIn(text: string, needle: string, caseSensitive: boolean): { from: number; to: number }[] {
  const found: { from: number; to: number }[] = [];
  if (needle === "") return found;
  const hay = caseSensitive ? text : text.toLowerCase();
  const wanted = caseSensitive ? needle : needle.toLowerCase();
  for (let at = hay.indexOf(wanted); at >= 0; at = hay.indexOf(wanted, at + wanted.length)) {
    found.push({ from: at, to: at + wanted.length });
  }
  return found;
}

export function createEditor(parent: HTMLElement, options: EditorOptions): NoteEditor {
  /** searchPos is the match the last find left, as a document offset. */
  let searchPos: number | null = null;
  let lastFind = { query: "", caseSensitive: false };

  /** wholePath is what a copy hands out for a picture: the path where it sits
   * on disk, so that it opens from anywhere. */
  const wholePath = (text: string) => text.replace(/^images\/[^\n]+$/gm, (line) => absolute(line, options.imagesDir));

  const extensions = [
    history(),
    EditorView.lineWrapping,
    noteView,
    matchField,
    longTokens,
    // A picture's line holds nothing but its path, so no edit may leave text on
    // it: the path is what the picture is drawn from.
    EditorState.changeFilter.of(picturesKept),
    doneBlocks.init((state) => ({ done: options.done, decorations: doneFlags(state.doc, options.done) })),
    pictureSource.of({
      url: (path) => imageURL(path),
      whole: (path) => absolute(path, options.imagesDir),
    }),
    placeholder(hintText(options.binding)),
    EditorView.contentAttributes.of({ spellcheck: "false" }),
    noteKeymap(options.binding),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) options.onChange();
      // A note whose finished blocks came and went is written again, the note's
      // text waiting for its own debounce.
      const before = update.startState.field(doneBlocks).done;
      const after = update.state.field(doneBlocks).done;
      if (before !== after) options.onDone(after);
    }),
    EditorView.domEventHandlers({
      paste(event, view) {
        const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
        if (files.length === 0) return false;
        event.preventDefault();
        void addPictures(view, files);
        return true;
      },
    }),
  ];

  // The caret goes where the last edit left it, and the view scrolls to it: a
  // note picked up in the middle reads from the line the user stopped on.
  const start = Math.max(0, Math.min(options.at, options.doc.length));
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: options.doc, selection: EditorSelection.cursor(start), extensions }),
  });
  if (start > 0) {
    view.dispatch({ effects: EditorView.scrollIntoView(start, { y: "center" }) });
  }

  /**
   * addPictures puts each picture on a line of its own, with a break before it and
   * a break after it: a picture is a path that fills its line, and nothing else on
   * that line is drawn. A line the caret sits in that holds nothing but its own
   * break takes the pictures itself, so no blank line is left above them; any other
   * line keeps its text and the pictures start under it. The caret waits on the
   * line below them.
   */
  async function addPictures(editor: EditorView, files: File[]) {
    const paths: string[] = [];
    for (const file of files) {
      const path = await options.onImage(file);
      if (path) paths.push(path);
    }
    if (paths.length === 0) return;
    const { state } = editor;
    const line = state.doc.lineAt(state.selection.main.from);
    const bare = line.text.trim() === "";
    const at = bare ? line.from : line.to;
    const insert = bare ? `${paths.join("\n")}\n` : `\n${paths.join("\n")}\n`;
    editor.dispatch({
      changes: { from: at, insert },
      selection: EditorSelection.cursor(at + insert.length),
      scrollIntoView: true,
    });
    editor.focus();
  }

  /** copiedText is what ⌘C hands out: the picture's whole path when the caret
   * stands on one, and the selected text otherwise. */
  function copiedText(): { text: string; picture: boolean } | null {
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    const path = picturePath(line.text);
    if (path !== null) return { text: absolute(path, options.imagesDir), picture: true };
    const selection = view.state.selection.main;
    const text = view.state.sliceDoc(selection.from, selection.to);
    return text === "" ? null : { text: wholePath(text), picture: false };
  }

  // The menu bar owns ⌘C and ⌘X: the page is asked to copy the selection, and
  // this is where the path of a picture and the whole paths of its block are
  // filled in.
  const onCopy = (event: ClipboardEvent) => {
    if (!view.hasFocus) return;
    const copied = copiedText();
    if (!copied) return;
    event.clipboardData?.setData("text/plain", copied.text);
    event.preventDefault();
    if (copied.picture) options.onStatus?.("Picture path copied");
  };

  const onCut = (event: ClipboardEvent) => {
    if (!view.hasFocus) return;
    const copied = copiedText();
    if (!copied) return;
    event.clipboardData?.setData("text/plain", copied.text);
    event.preventDefault();
    const selection = view.state.selection.main;
    const line = view.state.doc.lineAt(selection.head);
    if (copied.picture) {
      clearPicture(view, line);
      view.focus();
      return;
    }
    view.dispatch({
      changes: { from: selection.from, to: selection.to, insert: "" },
      selection: EditorSelection.cursor(selection.from),
    });
  };

  document.addEventListener("copy", onCopy, true);
  document.addEventListener("cut", onCut, true);

  function find(query: string, { caseSensitive, back }: FindOptions): FindResult {
    const found = matchesIn(view.state.doc.toString(), query, caseSensitive);
    if (found.length === 0) {
      searchPos = null;
      view.dispatch({ effects: setMatch.of(null) });
      return { total: 0, index: -1 };
    }
    const current = searchPos === null ? -1 : found.findIndex((match) => match.from === searchPos);
    const continuing = query === lastFind.query && caseSensitive === lastFind.caseSensitive;
    let index: number;
    if (current < 0) index = back ? found.length - 1 : 0;
    else if (!continuing) index = current;
    else index = (current + (back ? found.length - 1 : 1)) % found.length;
    const match = found[index]!;
    searchPos = match.from;
    lastFind = { query, caseSensitive };
    view.dispatch({
      selection: EditorSelection.range(match.from, match.to),
      effects: setMatch.of(match),
      scrollIntoView: true,
    });
    return { total: found.length, index };
  }

  function reveal(line: number, query: string, { caseSensitive }: { caseSensitive: boolean }) {
    const number = line + 1;
    if (number >= 1 && number <= view.state.doc.lines) {
      const text = view.state.doc.line(number);
      const found = matchesIn(text.text, query, caseSensitive)[0];
      if (found) {
        const match = { from: text.from + found.from, to: text.from + found.to };
        searchPos = match.from;
        lastFind = { query, caseSensitive };
        view.dispatch({
          selection: EditorSelection.range(match.from, match.to),
          effects: setMatch.of(match),
          scrollIntoView: true,
        });
        return;
      }
    }
    // The line moved since the search read the file: the note is searched from
    // the top instead, so that the caret still lands on a match.
    find(query, { caseSensitive, back: false });
  }

  function clearFind() {
    searchPos = null;
    lastFind = { query: "", caseSensitive: false };
    view.dispatch({ effects: setMatch.of(null) });
  }

  return {
    focus: () => view.focus(),
    text: () => view.state.doc.toString(),
    find,
    reveal,
    clearFind,
    selectionText: () => {
      const selection = view.state.selection.main;
      const text = view.state.sliceDoc(selection.from, selection.to);
      return text.includes("\n") ? "" : text;
    },
    position: () => view.state.selection.main.head,
    destroy: () => {
      document.removeEventListener("copy", onCopy, true);
      document.removeEventListener("cut", onCut, true);
      view.destroy();
    },
  };
}
