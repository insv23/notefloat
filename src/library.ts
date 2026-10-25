// The library the sidebar draws: the folders, their notes, and which note is
// open. Every write goes through this store, which reloads the library from Go
// afterwards and tells the page, so that no caller keeps a stale copy or
// forgets to draw the sidebar again.
import { Notes, type Buffer, type Library } from "./mygo";

export type Found = { folderIndex: number; buffer: Buffer };

export type LibraryStore = {
  state: () => Library;
  /** load reads the library for the first time. */
  load: () => Promise<Library>;
  reload: () => Promise<Library>;
  /** mutate runs a write through Go and reloads the library after it. */
  mutate: <T>(run: () => Promise<T>) => Promise<T>;
  find: (id: string) => Found | null;
  active: () => Buffer | undefined;
  titleOf: (id: string) => string;
  folderOfActive: () => string;
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
    active: () => find(state().active)?.buffer,
    titleOf: (id) => find(id)?.buffer.title ?? "Untitled",
    folderOfActive: () => {
      const found = find(state().active);
      return found ? state().folders[found.folderIndex]!.id : (state().folders[0]?.id ?? "");
    },
    subscribe: (listener) => {
      listeners.push(listener);
    },
  };
}
