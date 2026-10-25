// The editor's key map: which keys the settings decide, and which belong to the
// note whatever they say. A bindable key is matched against the settings on every
// press, so a shortcut changed in the settings works in the note already open.
// The fixed keys are the ones that must keep their place: a new line, taking a
// picture or a block away whole, and undo.
import { Prec, type Extension } from "@codemirror/state";
import { keymap, type EditorView, type KeyBinding } from "@codemirror/view";
import { insertNewline, redo, undo } from "@codemirror/commands";
import { accelFromEvent, canonical } from "../shortcuts";
import {
  addBlockAbove,
  addBlockBelow,
  backspace,
  deleteForward,
  goToBlock,
  moveBlock,
  selectBlock,
  splitBlock,
  toggleBlockDone,
  toggleLineCheck,
  toggleTodo,
} from "./commands";

/** editorActions are the commands the settings can bind, by action name. */
const editorActions: Record<string, (view: EditorView) => boolean> = {
  addBlockBelow,
  addBlockAbove,
  splitBlock,
  selectBlock,
  toggleTodo,
  toggleLineCheck,
  toggleBlockDone,
  previousBlock: (view) => goToBlock(view, -1),
  nextBlock: (view) => goToBlock(view, 1),
  moveBlockUp: (view) => moveBlock(view, -1),
  moveBlockDown: (view) => moveBlock(view, 1),
};

/** editorActionNames are the actions this key map answers for, which the page's
 * own key map has to leave alone. */
export const editorActionNames = Object.keys(editorActions);

/** noteKeys are the keys that stay the note's whatever the settings say: typing
 * a line, taking a picture or a block away whole, and undo. */
const noteKeys: KeyBinding[] = [
  { key: "Enter", run: insertNewline },
  { key: "Backspace", run: backspace },
  { key: "Delete", run: deleteForward },
  { key: "Mod-z", run: undo },
  { key: "Mod-Shift-z", run: redo },
  { key: "Mod-y", run: redo },
];

/** press answers one key press with the action the settings bind to it now. The
 * accelerators are read on every press and the map is rebuilt only when one of
 * them changed, which is what makes a rebound shortcut work in a note already
 * open. */
function press(binding: (action: string) => string) {
  let signature = "";
  let byKey = new Map<string, (view: EditorView) => boolean>();
  return (view: EditorView, event: KeyboardEvent): boolean => {
    const accels = editorActionNames.map((action) => canonical(binding(action)));
    const current = accels.join("\n");
    if (current !== signature) {
      signature = current;
      byKey = new Map();
      editorActionNames.forEach((action, index) => byKey.set(accels[index]!, editorActions[action]!));
    }
    const pressed = accelFromEvent(event);
    const run = pressed === null ? undefined : byKey.get(canonical(pressed));
    return run ? run(view) : false;
  };
}

/** noteKeymap is the editor's key map: the bindable actions ahead of the keys
 * that stay the note's own. */
export function noteKeymap(binding: (action: string) => string): Extension {
  return [Prec.high(keymap.of([{ any: press(binding) }])), keymap.of(noteKeys)];
}
