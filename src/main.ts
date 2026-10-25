// The app shell: the sidebar of folders and notes, the title, the shortcuts
// around the editor, and the panels laid over them. The notes and their folders
// live behind ./library.ts, the debounced write behind ./save.ts, the key map
// behind ./bindings.ts, and the editor itself in ./editor.ts.
import { Images, Notes, Preferences, events, type SearchHit, type Settings } from "./mygo";
import { createBindings } from "./bindings";
import { createEditor, type NoteEditor } from "./editor/index";
import { imeBusy, watchComposition } from "./ime";
import { createLibrary } from "./library";
import { createSaver } from "./save";
import { createFindBar, createNoteSearch, type FindBar, type NoteSearch } from "./search";
import { formatAccel } from "./shortcuts";
import { createSettings, type SettingsUI } from "./settings";
import { renderSidebar } from "./sidebar";

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

const app = $("#app");
const pinnedEl = $("#pinned");
const foldersEl = $("#folders");
const editorHost = $("#editor");
const titleEl = $<HTMLInputElement>("#title");
const statusEl = $("#status");
const settingsButton = $("#open-settings");
const newNoteButton = $("#new-note");
const newFolderButton = $("#new-folder");
const toggleSidebarButton = $("#toggle-sidebar");
const showSidebarButton = $("#show-sidebar");
const settingsHost = $("#settings");
const findbarHost = $("#findbar");
const searchDialogHost = $("#search-dialog");
const openSearchButton = $("#open-search");
const openSearchKey = $("#open-search-key");
const sidebarResizer = $("#sidebar-resizer");

const library = createLibrary();
const bindings = createBindings();

let settings: Settings;
let settingsUI: SettingsUI;
let activeId = "";
let view: NoteEditor | null = null;
let findBar: FindBar;
let noteSearch: NoteSearch;

const activeNote = () => library.active();

/** save writes the note on screen: the text the editor holds and the title. */
const save = createSaver(async () => {
  if (!view || !activeId) return;
  // The caret goes with the text: the note opens again where it was left.
  await Notes.save(activeId, titleEl.value, view.text(), view.position());
});

function renderSidebarNow() {
  renderSidebar({ pinned: pinnedEl, folders: foldersEl }, library.state(), activeId, {
    openNote: (id) => void openNote(id),
    newNote: (folderID) => void addNote(folderID),
    newFolder: () => void addFolder(),
    deleteNote: (id) => void deleteNote(id),
    deleteFolder: (id) => void deleteFolder(id),
    renameFolder: (id, title) => void renameFolder(id, title),
    togglePin: (id) => void togglePin(id),
    moveNote: (id, folderID, index) => void moveNote(id, folderID, index),
    reorderFolders: (ids) => void reorderFolders(ids),
  });
}

/** renderChrome puts the key that reaches each button in its tooltip. */
function renderChrome() {
  settingsButton.title = `Settings (${keyOf("settings")})`;
  newNoteButton.title = `New Note (${keyOf("newNote")})`;
  newFolderButton.title = `New Folder (${keyOf("newFolder")})`;
  toggleSidebarButton.title = `Hide Sidebar (${keyOf("toggleSidebar")})`;
  showSidebarButton.title = `Show Sidebar (${keyOf("toggleSidebar")})`;
  openSearchButton.title = `Search All Notes (${keyOf("findAll")})`;
  openSearchKey.textContent = keyOf("findAll");
}

const keyOf = (action: string) => formatAccel(settings.shortcuts[action] ?? "");

/** report puts a failure of the page on the title bar, where it can be read. It
 * is a diagnostic for the panel's own error handling, not a feature. */
function report(text: string) {
  const short = text.slice(0, 160);
  statusEl.textContent = short;
  window.setTimeout(() => {
    if (statusEl.textContent === short) statusEl.textContent = "";
  }, 8000);
}

window.addEventListener("error", (event) => report(`JS: ${event.message}`));
window.addEventListener("unhandledrejection", (event) => report(`JS: ${String(event.reason)}`));

function flash(text: string) {
  statusEl.textContent = text;
  window.setTimeout(() => {
    if (statusEl.textContent === text) statusEl.textContent = "";
  }, 1200);
}

// The sidebar the user can drag: the range the settings store, and the room the
// note keeps, so that a narrow panel never squeezes the note shut.
const SIDEBAR_MIN = 50;
const SIDEBAR_MAX = 360;
const SIDEBAR_DEFAULT = 200;
const NOTE_MIN = 260;

/** sidebarWidth is the width the user dragged to; what is drawn is that, clamped
 * to the room the panel has now. */
let sidebarWidth = SIDEBAR_DEFAULT;

function clampSidebarWidth(width: number): number {
  const room = Math.max(SIDEBAR_MIN, app.clientWidth - NOTE_MIN);
  return Math.round(Math.min(Math.max(width, SIDEBAR_MIN), Math.min(SIDEBAR_MAX, room)));
}

function applySidebarWidth() {
  app.style.setProperty("--sidebar-width", `${clampSidebarWidth(sidebarWidth)}px`);
}

/** setupSidebarResizer drags the sidebar's edge. The drag only moves the CSS
 * variable; the width is written to the settings once, when the pointer is let
 * go, instead of on every pixel. */
function setupSidebarResizer() {
  const saveWidth = () => {
    if (sidebarWidth === settings.sidebarWidth) return;
    settings.sidebarWidth = sidebarWidth;
    void Preferences.setSidebarWidth(sidebarWidth);
  };
  sidebarResizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const left = app.getBoundingClientRect().left;
    sidebarResizer.setPointerCapture(event.pointerId);
    sidebarResizer.classList.add("dragging");
    const move = (moveEvent: PointerEvent) => {
      sidebarWidth = clampSidebarWidth(moveEvent.clientX - left);
      applySidebarWidth();
    };
    const end = () => {
      sidebarResizer.removeEventListener("pointermove", move);
      sidebarResizer.removeEventListener("pointerup", end);
      sidebarResizer.removeEventListener("pointercancel", end);
      sidebarResizer.classList.remove("dragging");
      saveWidth();
    };
    sidebarResizer.addEventListener("pointermove", move);
    sidebarResizer.addEventListener("pointerup", end);
    sidebarResizer.addEventListener("pointercancel", end);
  });
  // A double click puts the sidebar back where it starts, for a drag that went
  // wrong, without hunting for the pixel it was at.
  sidebarResizer.addEventListener("dblclick", () => {
    sidebarWidth = SIDEBAR_DEFAULT;
    applySidebarWidth();
    saveWidth();
  });
  // A window narrower than the sidebar was dragged for takes room from it, and
  // gives it back when it grows: the width the user chose is kept either way.
  window.addEventListener("resize", applySidebarWidth);
}

function applySidebar() {
  sidebarWidth = settings.sidebarWidth || SIDEBAR_DEFAULT;
  app.classList.toggle("no-sidebar", settings.sidebarHidden);
  applySidebarWidth();
}

function toggleSidebar() {
  settings.sidebarHidden = !settings.sidebarHidden;
  applySidebar();
  void Preferences.setSidebarHidden(settings.sidebarHidden);
  // Hiding the sidebar takes its toggle with it, so the next note keeps the
  // keyboard instead of a button that went away.
  if (settings.sidebarHidden) view?.focus();
}

function applySettings(next: Settings) {
  settings = next;
  bindings.set(settings);
  applySidebar();
  renderChrome();
}

async function openNote(id: string) {
  await save.flush();
  const [text, done, at] = await Promise.all([Notes.load(id), Notes.doneBlocks(id), Notes.position(id)]);
  activeId = id;
  await Notes.activate(id);
  titleEl.value = library.titleOf(id);
  view?.destroy();
  view = createEditor(editorHost, {
    doc: text,
    at,
    done,
    imagesDir: library.state().imagesDir,
    binding: (action) => settings.shortcuts[action] ?? "",
    onChange: save.schedule,
    // The finished blocks sit beside the note in library.json, and are written
    // as the key is pressed: they are one flag, not a page of text.
    onDone: (flags) => void Notes.setDoneBlocks(id, flags).catch(() => {}),
    onImage: saveImage,
    onStatus: flash,
  });
  renderSidebarNow();
  renderChrome();
  findBar.noteChanged();
  if (!settingsUI.isOpen()) view.focus();
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let at = 0; at < bytes.length; at += chunk) {
    binary += String.fromCharCode(...bytes.subarray(at, at + chunk));
  }
  return btoa(binary);
}

/** saveImage writes a pasted picture beside the notes and returns its path. */
async function saveImage(file: File): Promise<string | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return Images.save(toBase64(bytes));
}

async function addNote(folderID = library.folderOfActive()) {
  await save.flush();
  const note = await library.mutate(() => Notes.create(folderID, "Untitled"));
  await openNote(note.id);
}

async function addFolder() {
  await save.flush();
  const folder = await library.mutate(() => Notes.createFolder("New Folder"));
  await openNote(folder.buffers[0]?.id ?? library.state().active);
}

async function deleteNote(id: string) {
  await save.flush();
  // The note is going: an editor left in place would write its file back.
  if (id === activeId) {
    view?.destroy();
    view = null;
  }
  await library.mutate(() => Notes.remove(id));
  if (library.state().active !== activeId) await openNote(library.state().active);
}

async function deleteFolder(id: string) {
  await save.flush();
  try {
    await library.mutate(() => Notes.removeFolder(id));
  } catch (err) {
    // The dialog canceled, or the last folder is kept.
    if (err instanceof Error && err.message) flash(err.message);
    return;
  }
  if (library.find(activeId)) return;
  // The note being edited went to the Trash with the folder: saving it on the
  // way to the next one would write its file back.
  view?.destroy();
  view = null;
  await openNote(library.state().active);
}

async function renameFolder(id: string, title: string) {
  await library.mutate(() => Notes.renameFolder(id, title));
}

async function moveNote(id: string, folderID: string, index: number) {
  await save.flush();
  await library.mutate(() => Notes.moveNote(id, folderID, index));
}

async function reorderFolders(ids: string[]) {
  await library.mutate(() => Notes.reorderFolders(ids));
}

async function togglePin(id: string) {
  const note = library.find(id)?.buffer;
  if (!note) return;
  const pinned = !note.pinned;
  await library.mutate(() => Notes.setPinned(id, pinned));
  flash(pinned ? "Pinned" : "Unpinned");
}

function openSettings() {
  // The editor would keep taking keystrokes under the overlay.
  (document.activeElement as HTMLElement | null)?.blur();
  void settingsUI.open();
}

function runAction(action: string) {
  switch (action) {
    case "newNote":
      void addNote();
      break;
    case "newFolder":
      void addFolder();
      break;
    case "pinNote":
      void togglePin(activeId);
      break;
    case "settings":
      openSettings();
      break;
    case "toggleSidebar":
      toggleSidebar();
      break;
    case "findInNote":
      findBar.open();
      break;
    case "findAll":
      openNoteSearch();
      break;
  }
}

/** openNoteSearch shows the search of every note over the panel. */
function openNoteSearch() {
  noteSearch.open();
}

/** openHit opens the note a search of every note found, at the line it found. */
async function openHit(hit: SearchHit, query: string, caseSensitive: boolean) {
  // The dialog goes away so that the note it opens is in view; the query stays
  // in its field for the next time it opens.
  noteSearch.close();
  if (!library.find(hit.note)) {
    // The note went away since the search read the files.
    await library.reload();
    if (!library.find(hit.note)) return;
  }
  await openNote(hit.note);
  view?.reveal(hit.line, query, { caseSensitive });
}

titleEl.addEventListener("input", () => {
  const note = activeNote();
  if (note) note.title = titleEl.value;
  renderSidebarNow();
  save.schedule();
});

titleEl.addEventListener("keydown", (event) => {
  // Enter committing an input method's candidate leaves the title alone.
  if (imeBusy(event)) return;
  if (event.key === "Enter") {
    event.preventDefault();
    titleEl.blur();
    view?.focus();
  }
});

document.addEventListener("keydown", (event) => {
  if (settingsUI?.isOpen()) return;
  const action = bindings.actionOf(event);
  if (!action) return;
  // The search dialog holds the keyboard: the only key it passes on is the one
  // that searches, which brings it back to the field.
  if (noteSearch?.isOpen() && action !== "findAll") return;
  event.preventDefault();
  runAction(action);
});

settingsButton.addEventListener("click", openSettings);
newNoteButton.addEventListener("click", () => void addNote());
newFolderButton.addEventListener("click", () => void addFolder());
toggleSidebarButton.addEventListener("click", toggleSidebar);
showSidebarButton.addEventListener("click", toggleSidebar);
openSearchButton.addEventListener("click", openNoteSearch);

// The panel is hidden rather than closed, so the page keeps its state; the
// caret has to be put back by hand once it appears again.
events.panelShown.on(() => {
  if (!settingsUI.isOpen()) view?.focus();
});

// Hiding writes the note at once, instead of waiting out the debounce would:
// the user can hide the panel and quit right after.
events.panelHidden.on(() => void save.flush());

// The tray's Settings item shows the panel and then asks for this.
events.openSettings.on(() => openSettings());

async function boot() {
  watchComposition();
  setupSidebarResizer();
  const [, stored] = await Promise.all([library.load(), Preferences.get()]);
  settings = stored;
  settingsUI = createSettings(settingsHost, {
    onSettings: applySettings,
    onDataDirChanged() {
      window.location.reload();
    },
    onClose() {
      view?.focus();
    },
  });
  bindings.set(settings);
  findBar = createFindBar(findbarHost, {
    editor: () => view,
    binding: (action) => settings.shortcuts[action] ?? "",
  });
  noteSearch = createNoteSearch(searchDialogHost, {
    beforeSearch: save.flush,
    openHit: (hit, query, caseSensitive) => void openHit(hit, query, caseSensitive),
    refocus: () => view?.focus(),
    binding: (action) => settings.shortcuts[action] ?? "",
  });
  library.subscribe(() => {
    renderSidebarNow();
    renderChrome();
  });
  applySidebar();
  renderChrome();
  renderSidebarNow();
  await openNote(library.state().active);
}

void boot();
