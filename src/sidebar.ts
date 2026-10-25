// The sidebar: the Pinned section, then a folder per project with its notes.
// Everything the user does here is a call back into main.ts, which writes it to
// the library and renders the sidebar again from the result.
import type { Buffer, Folder, Library } from "./mygo";
import { imeBusy } from "./ime";

export interface SidebarActions {
  openNote(id: string): void;
  newNote(folderID: string): void;
  newFolder(): void;
  deleteNote(id: string): void;
  deleteFolder(id: string): void;
  renameFolder(id: string, title: string): void;
  togglePin(id: string): void;
  moveNote(id: string, folderID: string, index: number): void;
  reorderFolders(ids: string[]): void;
}

export interface SidebarHosts {
  pinned: HTMLElement;
  folders: HTMLElement;
}

/** drag is what the user picked up, and stays unset unless a drag started in
 * this window: a drag from another app carries no folder or note of ours. */
let drag: { kind: "note" | "folder"; id: string } | null = null;

function clearDropMarks(root: HTMLElement) {
  for (const el of root.querySelectorAll(".drop-before, .drop-after, .drop-into")) {
    el.classList.remove("drop-before", "drop-after", "drop-into");
  }
}

/** dropSide reports whether the pointer is over the lower half of el, meaning
 * the dragged thing goes after it. */
function dropSide(event: DragEvent, el: Element): "before" | "after" {
  const rect = el.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function iconButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "icon";
  button.textContent = label;
  button.title = title;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

const FOLDER_PATH =
  "M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6c.4 0 .8.2 1 .5l.8 1h4.6A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z";

/** The pin's two states: hollow while the note is not pinned, solid once it is.
 * The shape says which, so the icon keeps the row's one color. */
const PIN_PATH =
  "M4.146.146A.5.5 0 0 1 4.5 0h7a.5.5 0 0 1 .5.5c0 .68-.342 1.174-.646 1.479-.126.125-.25.224-.354.298v4.431l.078.048c.203.127.476.314.751.555C12.36 7.775 13 8.527 13 9.5a.5.5 0 0 1-.5.5h-4v4.5c0 .276-.224 1.5-.5 1.5s-.5-1.224-.5-1.5V10h-4a.5.5 0 0 1-.5-.5c0-.973.64-1.725 1.17-2.189A6 6 0 0 1 5 6.708V2.277a3 3 0 0 1-.354-.298C4.342 1.674 4 1.179 4 .5a.5.5 0 0 1 .146-.354m1.58 1.408-.002-.001zm-.002-.001.002.001A.5.5 0 0 1 6 2v5a.5.5 0 0 1-.276.447h-.002l-.012.007-.054.03a5 5 0 0 0-.827.58c-.318.278-.585.596-.725.936h7.792c-.14-.34-.407-.658-.725-.936a5 5 0 0 0-.881-.61l-.012-.006h-.002A.5.5 0 0 1 10 7V2a.5.5 0 0 1 .295-.458 1.8 1.8 0 0 0 .351-.271c.08-.08.155-.17.214-.271H5.14q.091.15.214.271a1.8 1.8 0 0 0 .37.282";

const PIN_SOLID_PATH =
  "M4.146.146A.5.5 0 0 1 4.5 0h7a.5.5 0 0 1 .5.5c0 .68-.342 1.174-.646 1.479-.126.125-.25.224-.354.298v4.431l.078.048c.203.127.476.314.751.555C12.36 7.775 13 8.527 13 9.5a.5.5 0 0 1-.5.5h-4v4.5c0 .276-.224 1.5-.5 1.5s-.5-1.224-.5-1.5V10h-4a.5.5 0 0 1-.5-.5c0-.973.64-1.725 1.17-2.189A6 6 0 0 1 5 6.708V2.277a3 3 0 0 1-.354-.298C4.342 1.674 4 1.179 4 .5a.5.5 0 0 1 .146-.354z";

function pinMark(pinned: boolean): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", pinned ? PIN_SOLID_PATH : PIN_PATH);
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}

/** folderGlyph is the mark of a folder's name. */
function folderGlyph(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "folder-glyph");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", FOLDER_PATH);
  svg.append(path);
  return svg;
}

/** noteActions is the one place a note's pin and its delete button live: both
 * slots are always laid out, so the title keeps its width as the pointer moves,
 * and both show only while the pointer is on the row. */
function noteActions(buffer: Buffer, actions: SidebarActions): HTMLElement {
  const group = document.createElement("div");
  group.className = "buffer-actions";

  const pin = document.createElement("button");
  pin.className = "icon buffer-pin";
  pin.title = buffer.pinned ? "Unpin Note" : "Pin Note";
  pin.setAttribute("aria-label", pin.title);
  pin.append(pinMark(buffer.pinned ?? false));
  pin.addEventListener("click", (event) => {
    event.stopPropagation();
    actions.togglePin(buffer.id);
  });

  const remove = iconButton("×", "Delete Note", () => actions.deleteNote(buffer.id));
  remove.classList.add("buffer-remove");

  group.append(pin, remove);
  return group;
}

function noteItem(buffer: Buffer, folder: Folder, index: number, active: string, actions: SidebarActions): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "buffer" + (buffer.id === active ? " active" : "");
  item.dataset.noteId = buffer.id;
  item.dataset.folderId = folder.id;
  item.dataset.index = String(index);

  const name = document.createElement("button");
  name.className = "buffer-name";
  name.textContent = buffer.title || "Untitled";
  name.addEventListener("click", () => actions.openNote(buffer.id));

  item.append(name, noteActions(buffer, actions));

  // Dragging a note places it in a folder, itself or another one.
  item.draggable = true;
  item.addEventListener("dragstart", (event) => {
    drag = { kind: "note", id: buffer.id };
    event.dataTransfer?.setData("text/plain", buffer.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  });
  item.addEventListener("dragend", () => {
    drag = null;
    clearDropMarks(document.body);
  });
  item.addEventListener("dragover", (event) => {
    if (drag?.kind !== "note") return;
    event.preventDefault();
    event.stopPropagation();
    const side = dropSide(event, item);
    item.classList.toggle("drop-before", side === "before");
    item.classList.toggle("drop-after", side === "after");
  });
  item.addEventListener("dragleave", () => item.classList.remove("drop-before", "drop-after"));
  item.addEventListener("drop", (event) => {
    if (drag?.kind !== "note") return;
    event.preventDefault();
    event.stopPropagation();
    clearDropMarks(document.body);
    const side = dropSide(event, item);
    const at = Number(item.dataset.index) + (side === "after" ? 1 : 0);
    actions.moveNote(drag.id, folder.id, at);
    drag = null;
  });
  return item;
}

/** noteList draws the notes of a folder and takes a note dropped on the space
 * under them. */
function noteList(folder: Folder, active: string, actions: SidebarActions): HTMLUListElement {
  const list = document.createElement("ul");
  list.className = "buffers";
  list.dataset.folderId = folder.id;
  list.append(...folder.buffers.map((buffer, index) => noteItem(buffer, folder, index, active, actions)));
  list.addEventListener("dragover", (event) => {
    if (drag?.kind !== "note") return;
    event.preventDefault();
    list.classList.add("drop-into");
  });
  list.addEventListener("dragleave", () => list.classList.remove("drop-into"));
  list.addEventListener("drop", (event) => {
    if (drag?.kind !== "note") return;
    event.preventDefault();
    clearDropMarks(document.body);
    actions.moveNote(drag.id, folder.id, folder.buffers.length);
    drag = null;
  });
  return list;
}

/** rename puts an input over the folder's name and calls back with the new
 * title when the user commits it. */
function rename(span: HTMLElement, title: string, commit: (title: string) => void) {
  const input = document.createElement("input");
  input.className = "folder-rename";
  input.value = title;
  input.spellcheck = false;
  span.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (value: string | null) => {
    if (done) return;
    done = true;
    input.replaceWith(span);
    if (value !== null && value.trim() && value !== title) commit(value.trim());
  };
  input.addEventListener("keydown", (event) => {
    // The Enter the input method uses to commit a candidate ends nothing.
    if (imeBusy(event)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      finish(input.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(null);
    }
    event.stopPropagation();
  });
  input.addEventListener("blur", () => finish(input.value));
}

function folderItem(folder: Folder, library: Library, active: string, host: HTMLElement, actions: SidebarActions): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "folder";
  item.dataset.folderId = folder.id;

  const head = document.createElement("div");
  head.className = "folder-head";
  head.draggable = true;

  const name = document.createElement("span");
  name.className = "folder-name";
  name.textContent = folder.title;
  name.title = "Double-click to rename";
  name.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    rename(name, folder.title, (title) => actions.renameFolder(folder.id, title));
  });

  const buttons = document.createElement("div");
  buttons.className = "folder-actions";
  buttons.append(iconButton("+", "New Note", () => actions.newNote(folder.id)));
  if (library.folders.length > 1) {
    buttons.append(iconButton("×", "Delete Folder", () => actions.deleteFolder(folder.id)));
  }

  head.append(folderGlyph(), name, buttons);

  head.addEventListener("dragstart", (event) => {
    drag = { kind: "folder", id: folder.id };
    event.dataTransfer?.setData("text/plain", folder.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    item.classList.add("dragging");
  });
  head.addEventListener("dragend", () => {
    drag = null;
    item.classList.remove("dragging");
    clearDropMarks(host);
  });

  // A note dropped on the folder's name joins the end of its notes; a folder
  // dropped there moves.
  head.addEventListener("dragover", (event) => {
    if (drag?.kind !== "note") return;
    event.preventDefault();
    event.stopPropagation();
    head.classList.add("drop-into");
  });
  head.addEventListener("dragleave", () => head.classList.remove("drop-into"));
  head.addEventListener("drop", (event) => {
    if (drag?.kind !== "note") return;
    event.preventDefault();
    event.stopPropagation();
    clearDropMarks(document.body);
    actions.moveNote(drag.id, folder.id, folder.buffers.length);
    drag = null;
  });

  item.addEventListener("dragover", (event) => {
    if (drag?.kind !== "folder") return;
    event.preventDefault();
    const side = dropSide(event, head);
    item.classList.toggle("drop-before", side === "before");
    item.classList.toggle("drop-after", side === "after");
  });
  item.addEventListener("dragleave", () => item.classList.remove("drop-before", "drop-after"));
  item.addEventListener("drop", (event) => {
    if (drag?.kind !== "folder") return;
    event.preventDefault();
    clearDropMarks(host);
    const side = dropSide(event, head);
    const moved = drag.id;
    const order = library.folders.map((f) => f.id);
    const from = order.indexOf(moved);
    const target = order.indexOf(folder.id);
    if (from < 0 || target < 0 || moved === folder.id) return;
    const insertAt = target + (side === "after" ? 1 : 0);
    const rest = order.filter((id) => id !== moved);
    rest.splice(from < insertAt ? insertAt - 1 : insertAt, 0, moved);
    drag = null;
    actions.reorderFolders(rest);
  });

  item.append(head, noteList(folder, active, actions));
  return item;
}

/** renderSidebar draws the whole sidebar from the library. */
export function renderSidebar(hosts: SidebarHosts, library: Library, active: string, actions: SidebarActions) {
  const pinned = library.folders.flatMap((folder) => folder.buffers.filter((buffer) => buffer.pinned));
  // The Pinned section stays where it is whether or not anything is pinned: it
  // is a place in the sidebar, not a folder that appears and disappears. Notes
  // in it or nothing in it, and no line saying which.
  hosts.pinned.replaceChildren(
    ...pinned.map((buffer) => {
      const item = document.createElement("li");
      item.className = "buffer" + (buffer.id === active ? " active" : "");
      const name = document.createElement("button");
      name.className = "buffer-name";
      name.textContent = buffer.title || "Untitled";
      name.addEventListener("click", () => actions.openNote(buffer.id));
      item.append(name, noteActions(buffer, actions));
      return item;
    }),
  );
  hosts.folders.replaceChildren(
    ...library.folders.map((folder) => folderItem(folder, library, active, hosts.folders, actions)),
  );
}
