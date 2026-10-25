// Writing the note the user is in. A keystroke schedules the write, so that a
// burst of typing costs one file write, and the panel hiding or another note
// opening writes at once: the app can quit right after either.

const WRITE_DELAY_MS = 400;

export type Saver = {
  /** schedule writes the note once the user stops typing for a moment. */
  schedule: () => void;
  /** flush writes now, and cancels the scheduled write. */
  flush: () => Promise<void>;
  /** cancel drops the scheduled write: the note it would write is gone. */
  cancel: () => void;
};

export function createSaver(write: () => Promise<void>): Saver {
  let timer = 0;

  function cancel() {
    window.clearTimeout(timer);
    timer = 0;
  }

  return {
    schedule() {
      cancel();
      timer = window.setTimeout(() => void write().catch(() => {}), WRITE_DELAY_MS);
    },
    async flush() {
      cancel();
      await write();
    },
    cancel,
  };
}
