// The two searches. The bar under the title searches the note that is open and
// marks the word it stopped on, keeping the caret in the field so that typing
// goes on narrowing the query. The dialog in the middle of the panel searches
// every note: it lists the matching lines with a line of context on either
// side, and opening one puts the caret on the word. Both match plain text,
// case-sensitively when Aa is on.
import type { NoteEditor } from "./editor";
import { Notes, type SearchHit } from "./mygo";
import { formatAccel } from "./shortcuts";

/** SEARCH_DELAY_MS waits out a burst of typing before the files are read. */
const SEARCH_DELAY_MS = 160;
/** CONTEXT_CHARS is how much of the line a result shows on either side of the
 * word it found: the word reads in its place, the ends of a long line do not
 * matter. */
const CONTEXT_CHARS = 32;

export type FindBar = {
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
  /** noteChanged closes the bar: the next note opens with no search left. */
  noteChanged: () => void;
};

export type FindBarOptions = {
  editor: () => NoteEditor | null;
  /** binding is the accelerator the settings hold for an action. */
  binding: (action: string) => string;
};

/**
 * createFindBar fills host with the find field of the note on screen: the
 * query, the count of its matches, the case switch, the two steps and the way
 * out. Return steps forward, Shift-Return back, and Escape closes the bar and
 * gives the keyboard back to the editor.
 */
export function createFindBar(host: HTMLElement, options: FindBarOptions): FindBar {
  const input = document.createElement("input");
  input.className = "find-input";
  input.type = "text";
  input.placeholder = "Find in Note";
  input.spellcheck = false;
  input.autocomplete = "off";
  const count = document.createElement("span");
  count.className = "find-count";
  const caseButton = document.createElement("button");
  caseButton.type = "button";
  caseButton.className = "find-case";
  caseButton.textContent = "Aa";
  caseButton.title = "Match Case";
  caseButton.setAttribute("aria-pressed", "false");
  const previous = stepButton("↑", "Previous Match");
  const next = stepButton("↓", "Next Match");
  const closeButton = stepButton("×", "Close Find");
  host.replaceChildren(input, count, caseButton, previous, next, closeButton);

  let caseSensitive = false;

  function run(back: boolean) {
    const editor = options.editor();
    const query = input.value;
    if (!editor || query === "") {
      editor?.clearFind();
      count.textContent = "";
      return;
    }
    const found = editor.find(query, { caseSensitive, back });
    count.textContent = found.total === 0 ? "No matches" : `${found.index + 1}/${found.total}`;
  }

  function close() {
    host.hidden = true;
    options.editor()?.clearFind();
    count.textContent = "";
    options.editor()?.focus();
  }

  input.addEventListener("input", () => run(false));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Enter" || event.key === "Return") {
      event.preventDefault();
      run(!event.shiftKey);
    }
  });
  caseButton.addEventListener("click", () => {
    caseSensitive = !caseSensitive;
    caseButton.classList.toggle("on", caseSensitive);
    caseButton.setAttribute("aria-pressed", String(caseSensitive));
    run(false);
  });
  previous.addEventListener("click", () => run(true));
  next.addEventListener("click", () => run(false));
  closeButton.addEventListener("click", close);

  return {
    open: () => {
      input.title = `Find in Note (${formatAccel(options.binding("findInNote"))})`;
      host.hidden = false;
      // A word the caret holds is what the user means to find.
      const held = options.editor()?.selectionText() ?? "";
      if (held && !input.value) input.value = held;
      input.focus();
      input.select();
      if (input.value) run(false);
    },
    close,
    isOpen: () => !host.hidden,
    noteChanged: () => {
      if (!host.hidden) close();
    },
  };
}

function stepButton(glyph: string, title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.textContent = glyph;
  return button;
}

export type NoteSearch = {
  /** open shows the dialog with the query the last search held. */
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
};

export type NoteSearchOptions = {
  /** beforeSearch writes what the editor holds, so that the files read are the
   * note the user sees. */
  beforeSearch: () => Promise<void>;
  /** openHit shows a note at the line the search found. */
  openHit: (hit: SearchHit, query: string, caseSensitive: boolean) => void;
  /** refocus puts the keyboard back in the editor, once the dialog is away. */
  refocus: () => void;
  /** binding is the accelerator the settings hold for an action. */
  binding: (action: string) => string;
};

type Row = { hit: SearchHit; element: HTMLElement };

/**
 * createNoteSearch fills host with the search of every note: a card over the
 * panel, with the query at the top and one result per matching line, each
 * showing the line above and below it. A press outside the card closes it and
 * the query stays in the field, so that the next search carries on where the
 * last one was.
 */
export function createNoteSearch(host: HTMLElement, options: NoteSearchOptions): NoteSearch {
  host.className = "search-dialog";
  host.hidden = true;

  const card = document.createElement("div");
  card.className = "search-card";
  const field = document.createElement("div");
  field.className = "search-field";
  const glyph = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  glyph.setAttribute("viewBox", "0 0 16 16");
  glyph.setAttribute("class", "search-glyph");
  glyph.setAttribute("aria-hidden", "true");
  const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  ring.setAttribute("cx", "6.8");
  ring.setAttribute("cy", "6.8");
  ring.setAttribute("r", "4.2");
  const handle = document.createElementNS("http://www.w3.org/2000/svg", "path");
  handle.setAttribute("d", "M10 10 13.5 13.5");
  glyph.append(ring, handle);
  const input = document.createElement("input");
  input.className = "search-input";
  input.type = "text";
  input.placeholder = "Search All Notes";
  input.spellcheck = false;
  input.autocomplete = "off";
  const caseButton = document.createElement("button");
  caseButton.type = "button";
  caseButton.className = "search-case";
  caseButton.textContent = "Aa";
  caseButton.title = "Match Case";
  caseButton.setAttribute("aria-pressed", "false");
  field.append(glyph, input, caseButton);
  const list = document.createElement("div");
  list.className = "search-list";
  card.append(field, list);
  host.append(card);

  let caseSensitive = false;
  let rows: Row[] = [];
  let current = -1;
  /** token counts the searches started, so that a slow one cannot draw over a
   * list a later keystroke already owns. */
  let token = 0;
  let timer = 0;

  function paintCurrent() {
    rows.forEach((row, index) => row.element.classList.toggle("current", index === current));
    rows[current]?.element.scrollIntoView({ block: "nearest" });
  }

  function line(className: string, text: string): HTMLElement {
    const node = document.createElement("div");
    node.className = className;
    node.textContent = text;
    return node;
  }

  /** draw builds one result per matching line: the note it is in above it, and
   * a line of context on either side so that the match reads in place. The
   * line found is shown around the word, and only the word is marked. */
  function draw(hits: SearchHit[], query: string) {
    const built: Row[] = [];
    const nodes: HTMLElement[] = [];
    let note = "";
    for (const hit of hits) {
      if (hit.note !== note) {
        note = hit.note;
        nodes.push(line("search-note", hit.title || "Untitled"));
      }
      const row = document.createElement("div");
      row.className = "search-hit";
      row.append(line("search-context", hit.before));
      const start = Math.max(0, hit.offset - CONTEXT_CHARS);
      const end = Math.min(hit.text.length, hit.offset + query.length + CONTEXT_CHARS);
      const found = line("search-line", (start > 0 ? "…" : "") + hit.text.slice(start, hit.offset));
      const mark = document.createElement("mark");
      mark.textContent = hit.text.slice(hit.offset, Math.min(hit.offset + query.length, hit.text.length));
      found.append(mark, document.createTextNode(hit.text.slice(hit.offset + query.length, end) + (end < hit.text.length ? "…" : "")));
      row.append(found, line("search-context", hit.after));
      row.addEventListener("click", () => options.openHit(hit, query, caseSensitive));
      nodes.push(row);
      built.push({ hit, element: row });
    }
    if (hits.length === 0) nodes.push(line("search-empty", "No matches"));
    list.replaceChildren(...nodes);
    return built;
  }

  async function search() {
    window.clearTimeout(timer);
    const query = input.value.trim();
    const mine = ++token;
    if (query === "") {
      rows = [];
      current = -1;
      list.replaceChildren();
      return;
    }
    await options.beforeSearch();
    let hits: SearchHit[];
    try {
      hits = await Notes.search(query, caseSensitive);
    } catch {
      if (mine !== token) return;
      list.replaceChildren(line("search-empty", "Search failed"));
      rows = [];
      current = -1;
      return;
    }
    if (mine !== token) return;
    rows = draw(hits, query);
    current = rows.length > 0 ? 0 : -1;
    paintCurrent();
  }

  function close() {
    if (host.hidden) return;
    host.hidden = true;
    // The field went with the card: the note takes the keyboard back.
    options.refocus();
  }

  input.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void search(), SEARCH_DELAY_MS);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (rows.length === 0) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      current = (current + step + rows.length) % rows.length;
      paintCurrent();
      return;
    }
    if (event.key === "Enter" || event.key === "Return") {
      const row = rows[current];
      if (!row) return;
      event.preventDefault();
      options.openHit(row.hit, input.value.trim(), caseSensitive);
    }
  });
  caseButton.addEventListener("click", () => {
    caseSensitive = !caseSensitive;
    caseButton.classList.toggle("on", caseSensitive);
    caseButton.setAttribute("aria-pressed", String(caseSensitive));
    if (input.value.trim() !== "") void search();
  });
  // A press on the card is the dialog's own; anywhere else closes it.
  host.addEventListener("mousedown", (event) => {
    if (event.target instanceof Node && card.contains(event.target)) return;
    event.preventDefault();
    close();
  });

  return {
    open: () => {
      input.title = `Search All Notes (${formatAccel(options.binding("findAll"))})`;
      host.hidden = false;
      input.focus();
      input.select();
      if (input.value.trim() !== "") void search();
    },
    close,
    isOpen: () => !host.hidden,
  };
}
