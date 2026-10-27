// The editor's key map: which keys the settings decide, and which belong to the
// note whatever they say. A bindable key is matched against the settings on every
// press, so a shortcut changed in the settings works in the note already open.
// The fixed keys are the ones that must keep their place: a new line, the two
// keys that step across a picture, the two delete keys and the boundary they take
// from a block, and undo.
import { Prec, type Extension } from "@codemirror/state";
import { keymap, type EditorView, type KeyBinding } from "@codemirror/view";
import { insertNewline, redo, undo } from "@codemirror/commands";
import { accelFromEvent, canonical } from "../shortcuts";
import {
  addBlockAbove,
  addBlockBelow,
  backspace,
  deleteForward,
  foldAllBlocks,
  goToBlock,
  moveBlock,
  selectBlock,
  splitBlock,
  stepAcrossPicture,
  toggleBlockDone,
  toggleBlockFold,
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
  toggleBlockFold,
  foldAllBlocks,
  previousBlock: (view) => goToBlock(view, -1),
  nextBlock: (view) => goToBlock(view, 1),
  moveBlockUp: (view) => moveBlock(view, -1),
  moveBlockDown: (view) => moveBlock(view, 1),
};

/** editorActionNames are the actions this key map answers for, which the page's
 * own key map has to leave alone. */
export const editorActionNames = Object.keys(editorActions);

/** noteKeys are the keys that stay the note's whatever the settings say: typing
 * a line, stepping across a picture, taking a picture's path or a block's
 * boundary away, and undo. */
const noteKeys: KeyBinding[] = [
  { key: "Enter", run: insertNewline },
  { key: "Backspace", run: backspace },
  { key: "Delete", run: deleteForward },
  // macOS TextEdit has no delete to the end of the line either, and the key would
  // only join the line below onto a picture's path.
  { key: "Mod-Delete", run: () => true },
  { key: "ArrowLeft", run: (view) => stepAcrossPicture(view, false, false) },
  { key: "ArrowRight", run: (view) => stepAcrossPicture(view, true, false) },
  { key: "Shift-ArrowLeft", run: (view) => stepAcrossPicture(view, false, true) },
  { key: "Shift-ArrowRight", run: (view) => stepAcrossPicture(view, true, true) },
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
