// The page's own shortcuts: a key press matched against the accelerators in the
// settings. The panel's summoning key is the system's and the note's own keys are
// the editor's, so both are left out here: matching them too would run them
// twice.
import { editorActionNames } from "./editor/keymap";
import { accelFromEvent, canonical } from "./shortcuts";
import type { Settings } from "./mygo";

/** OWNED_ELSEWHERE are the actions this map must not answer for. */
const OWNED_ELSEWHERE = new Set(["togglePanel", ...editorActionNames]);

export type Bindings = {
  /** set binds the actions the settings hold now. */
  set: (settings: Settings) => void;
  /** actionOf names the action a key press runs, or null when it runs none. */
  actionOf: (event: KeyboardEvent) => string | null;
};

export function createBindings(): Bindings {
  let map = new Map<string, string>();

  return {
    set(settings) {
      map = new Map();
      for (const [action, accel] of Object.entries(settings.shortcuts)) {
        if (OWNED_ELSEWHERE.has(action)) continue;
        map.set(canonical(accel), action);
      }
    },
    actionOf(event) {
      const pressed = accelFromEvent(event);
      return pressed === null ? null : (map.get(canonical(pressed)) ?? null);
    },
  };
}
