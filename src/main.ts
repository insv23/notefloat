// The app shell: the sidebar of folders and notes, the title, and the
// shortcuts around the editor in src/editor.ts. Notes and pictures live in
// files (see store.go), so nothing here keeps the text: it asks Go for it and
// hands back every change. What the keys do comes from the settings, which the
// settings overlay writes.
import { Images, Notes, Preferences, events, type Buffer, type Library, type SearchHit, type Settings } from "./mygo";
import { createEditor, type NoteEditor } from "./editor";
import { imeBusy, watchComposition } from "./ime";
import { createFindBar, createNoteSearch, type FindBar, type NoteSearch } from "./search";
import { accelFromEvent, canonical, formatAccel } from "./shortcuts";
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

let library: Library;
let settings: Settings;
let settingsUI: SettingsUI;
let activeId = "";
let view: NoteEditor | null = null;
let findBar: FindBar;
let noteSearch: NoteSearch;
let saveTimer = 0;
/** binds maps an accelerator to the action it runs, global ones aside: the
 * system already registers those. */
let binds = new Map<string, string>();

function findNote(id: string): { folderIndex: number; buffer: Buffer } | null {
  for (let folderIndex = 0; folderIndex < library.folders.length; folderIndex++) {
    const buffer = library.folders[folderIndex]!.buffers.find((note) => note.id === id);
    if (buffer) return { folderIndex, buffer };
  }
  return null;
}

const activeNote = () => findNote(activeId)?.buffer;

const titleOf = (id: string) => findNote(id)?.buffer.title ?? "Untitled";

function folderOfActive(): string {
  const found = findNote(activeId);
  return found ? library.folders[found.folderIndex]!.id : (library.folders[0]?.id ?? "");
}

function scheduleSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void flush(), 400);
}

async function flush() {
  window.clearTimeout(saveTimer);
  if (!view || !activeId) return;
  await Notes.save(activeId, titleEl.value, view.text());
}

async function openNote(id: string) {
  await flush();
  const text = await Notes.load(id);
  activeId = id;
  await Notes.activate(id);
  titleEl.value = titleOf(id);
  view?.destroy();
  editorHost.replaceChildren();
  view = createEditor(editorHost, {
    doc: text,
    imagesDir: library.imagesDir,
    binding: (action) => settings.shortcuts[action] ?? "",
    onChange: scheduleSave,
    onImage: saveImage,
    onStatus: flash,
  });
  renderSidebarNow();
  renderChrome();
  findBar?.noteChanged();
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

function renderSidebarNow() {
  renderSidebar({ pinned: pinnedEl, folders: foldersEl }, library, activeId, {
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

/** renderChrome shows the state of the active note's pin and the keys that
 * reach each button. */
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

function flash(text: string) {
  statusEl.textContent = text;
  window.setTimeout(() => {
    if (statusEl.textContent === text) statusEl.textContent = "";
  }, 1200);
}

function applySidebar() {
  app.classList.toggle("no-sidebar", settings.sidebarHidden);
}

function toggleSidebar() {
  settings.sidebarHidden = !settings.sidebarHidden;
  applySidebar();
  void Preferences.setSidebarHidden(settings.sidebarHidden);
  // Hiding the sidebar takes its toggle with it, so the next note keeps the
  // keyboard instead of a button that went away.
  if (settings.sidebarHidden) view?.focus();
}

async function reloadLibrary() {
  library = await Notes.library();
  renderSidebarNow();
  renderChrome();
}

async function addNote(folderID = folderOfActive()) {
  await flush();
  await Notes.create(folderID, "Untitled");
  library = await Notes.library();
  renderSidebarNow();
  await openNote(library.active);
}

async function addFolder() {
  await flush();
  await Notes.createFolder("New Folder");
  library = await Notes.library();
  renderSidebarNow();
  await openNote(library.active);
}

async function deleteNote(id: string) {
  await flush();
  if (id === activeId) view = null;
  await Notes.remove(id);
  library = await Notes.library();
  renderSidebarNow();
  if (library.active !== activeId) await openNote(library.active);
}

async function deleteFolder(id: string) {
  await flush();
  try {
    await Notes.removeFolder(id);
  } catch (err) {
    // The dialog canceled, or the last folder is kept.
    if (err instanceof Error && err.message) flash(err.message);
    return;
  }
  library = await Notes.library();
  renderSidebarNow();
  if (!findNote(activeId)) {
    // The note being edited went to the Trash with the folder: saving it on
    // the way to the next one would write its file back.
    view?.destroy();
    view = null;
    await openNote(library.active);
  }
}

async function renameFolder(id: string, title: string) {
  await Notes.renameFolder(id, title);
  await reloadLibrary();
}

async function moveNote(id: string, folderID: string, index: number) {
  await flush();
  await Notes.moveNote(id, folderID, index);
  await reloadLibrary();
}

async function reorderFolders(ids: string[]) {
  await Notes.reorderFolders(ids);
  await reloadLibrary();
}

async function togglePin(id: string) {
  const note = findNote(id)?.buffer;
  if (!note) return;
  const pinned = !note.pinned;
  await Notes.setPinned(id, pinned);
  await reloadLibrary();
  flash(pinned ? "Pinned" : "Unpinned");
}

function openSettings() {
  // The editor would keep taking keystrokes under the overlay.
  (document.activeElement as HTMLElement | null)?.blur();
  void settingsUI.open();
}

function bindShortcuts() {
  binds = new Map();
  for (const [action, accel] of Object.entries(settings.shortcuts)) {
    // The panel's own shortcut belongs to the system, and the block's move
    // shortcuts belong to the editor, which reads them itself: matching them
    // here too would run the action twice.
    if (action === "togglePanel" || action === "moveBlockUp" || action === "moveBlockDown") continue;
    binds.set(canonical(accel), action);
  }
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
  if (!findNote(hit.note)) {
    // The note went away since the search read the files.
    await reloadLibrary();
    if (!findNote(hit.note)) return;
  }
  await openNote(hit.note);
  view?.reveal(hit.line, query, { caseSensitive });
}

titleEl.addEventListener("input", () => {
  const note = activeNote();
  if (note) note.title = titleEl.value;
  renderSidebarNow();
  scheduleSave();
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
  const accel = accelFromEvent(event);
  if (!accel) return;
  const action = binds.get(accel);
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

// Hiding writes the note at once, instead of waiting out the 400ms the
// debounce would: the user can hide the panel and quit right after.
events.panelHidden.on(() => void flush());

// The tray's Settings item shows the panel and then asks for this.
events.openSettings.on(() => openSettings());

async function boot() {
  watchComposition();
  [library, settings] = await Promise.all([Notes.library(), Preferences.get()]);
  settingsUI = createSettings(settingsHost, {
    onSettings(next) {
      settings = next;
      bindShortcuts();
      applySidebar();
      renderChrome();
    },
    onDataDirChanged() {
      window.location.reload();
    },
    onClose() {
      view?.focus();
    },
  });
  bindShortcuts();
  findBar = createFindBar(findbarHost, {
    editor: () => view,
    binding: (action) => settings.shortcuts[action] ?? "",
  });
  noteSearch = createNoteSearch(searchDialogHost, {
    beforeSearch: flush,
    openHit: (hit, query, caseSensitive) => void openHit(hit, query, caseSensitive),
    refocus: () => view?.focus(),
    binding: (action) => settings.shortcuts[action] ?? "",
  });
  applySidebar();
  renderChrome();
  renderSidebarNow();
  await openNote(library.active);
}

void boot();
