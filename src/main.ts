// The app shell: the sidebar of buffers, the title, and the shortcuts around
// the editor in src/editor.ts. Notes and pictures live in files (see
// store.go), so nothing here keeps the text: it asks Go for it and hands back
// every change.
import { Images, Notes, events } from "./mygo";
import { createEditor, type NoteEditor } from "./editor";

type Library = Awaited<ReturnType<typeof Notes.library>>;

const SIDEBAR_KEY = "notefloat.sidebar";

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

const app = $("#app");
const buffersEl = $("#buffers");
const editorHost = $("#editor");
const titleEl = $<HTMLInputElement>("#title");
const statusEl = $("#status");

let library: Library;
let activeId = "";
let view: NoteEditor | null = null;
let saveTimer = 0;

const titleOf = (id: string) => library.buffers.find((buffer) => buffer.id === id)?.title ?? "未命名";

function scheduleSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void flush(), 400);
}

async function flush() {
  window.clearTimeout(saveTimer);
  if (!view || !activeId) return;
  await Notes.save(activeId, titleEl.value, view.text());
}

async function openBuffer(id: string) {
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
    onChange: scheduleSave,
    onImage: saveImage,
    onStatus: flash,
  });
  view.focus();
  renderBuffers();
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

function renderBuffers() {
  buffersEl.replaceChildren(
    ...library.buffers.map((buffer) => {
      const item = document.createElement("li");
      item.className = "buffer" + (buffer.id === activeId ? " active" : "");
      const name = document.createElement("button");
      name.className = "buffer-name";
      name.textContent = buffer.title || "未命名";
      name.addEventListener("click", () => void openBuffer(buffer.id));
      const remove = document.createElement("button");
      remove.className = "icon buffer-remove";
      remove.textContent = "×";
      remove.title = "删除 buffer";
      remove.addEventListener("click", async () => {
        if (library.buffers.length === 1) return;
        await flush();
        await Notes.remove(buffer.id);
        library = await Notes.library();
        await openBuffer(library.active);
      });
      item.append(name, remove);
      return item;
    }),
  );
}

function flash(text: string) {
  statusEl.textContent = text;
  window.setTimeout(() => {
    if (statusEl.textContent === text) statusEl.textContent = "";
  }, 1200);
}

function setSidebar(shown: boolean) {
  app.classList.toggle("no-sidebar", !shown);
  localStorage.setItem(SIDEBAR_KEY, shown ? "1" : "0");
}

async function addBuffer() {
  await flush();
  const buffer = await Notes.create(`笔记 ${library.buffers.length + 1}`);
  library = await Notes.library();
  await openBuffer(buffer.id);
}

$("#toggle-sidebar").addEventListener("click", () => setSidebar(app.classList.contains("no-sidebar")));
$("#new-buffer").addEventListener("click", () => void addBuffer());

titleEl.addEventListener("input", () => {
  const buffer = library.buffers.find((b) => b.id === activeId);
  if (buffer) buffer.title = titleEl.value;
  renderBuffers();
  scheduleSave();
});

document.addEventListener("keydown", (event) => {
  const mod = event.metaKey || event.ctrlKey;
  if (!mod) return;
  const key = event.key.toLowerCase();
  if (key === "b") {
    event.preventDefault();
    setSidebar(app.classList.contains("no-sidebar"));
  } else if (key === "n" && event.shiftKey) {
    event.preventDefault();
    void addBuffer();
  } else if (key === "s") {
    event.preventDefault();
    void flush().then(() => flash("已保存"));
  }
});

// The panel is hidden rather than closed, so the page keeps its state; the
// caret has to be put back by hand once it appears again.
events.panelShown.on(() => view?.focus());

async function boot() {
  library = await Notes.library();
  setSidebar(localStorage.getItem(SIDEBAR_KEY) !== "0");
  renderBuffers();
  await openBuffer(library.active);
}

void boot();
