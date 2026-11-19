// The library the sidebar draws: the folders and their notes. Every write goes
// through this store, which reloads the library from Go afterwards and tells the
// page, so that no caller keeps a stale copy or forgets to draw the sidebar
// again. Which note is open is not here: that is the page's, and Go only
// remembers it for the next launch.
import { Notes, type Buffer, type Library } from "./mygo";

export type Found = { folderIndex: number; buffer: Buffer };

export type LibraryStore = {
  state: () => Library;
  /** load reads the library for the first time. */
  load: () => Promise<Library>;
  reload: () => Promise<Library>;
  /** mutate runs a write through Go and reloads the library after it. */
  mutate: <T>(run: () => Promise<T>) => Promise<T>;
  /** setCollapsed records a folder's folded state in the copy on hand without
   * reloading it: a reload redraws the sidebar and takes the row out from under
   * the click that folded it. Go holds the state; the next reload reads it. */
  setCollapsed: (id: string, collapsed: boolean) => void;
  find: (id: string) => Found | null;
  subscribe: (listener: (library: Library) => void) => void;
};

export function createLibrary(): LibraryStore {
  let library: Library | null = null;
  const listeners: ((library: Library) => void)[] = [];

  async function reload(): Promise<Library> {
    library = await Notes.library();
    for (const listener of listeners) listener(library);
    return library;
  }

  function state(): Library {
    if (!library) throw new Error("the library was not loaded");
    return library;
  }

  function find(id: string): Found | null {
    for (const [folderIndex, folder] of state().folders.entries()) {
      const buffer = folder.buffers.find((note) => note.id === id);
      if (buffer) return { folderIndex, buffer };
    }
    return null;
  }

  function setCollapsed(id: string, collapsed: boolean) {
    const folder = library?.folders.find((folder) => folder.id === id);
    if (folder) folder.collapsed = collapsed;
  }

  return {
    state,
    load: reload,
    reload,
    async mutate<T>(run: () => Promise<T>) {
      const result = await run();
      await reload();
      return result;
    },
    find,
    setCollapsed,
    subscribe: (listener) => {
      listeners.push(listener);
    },
  };
}
