// Keyboard accelerators as the app stores them: mygo's syntax, with Super for
// Command on the Mac. The page turns a key press into that syntax so that a
// shortcut the user changed in the settings matches here, and formats it the
// way the Mac shows it.

const MODIFIER_ORDER = ["Super", "Ctrl", "Alt", "Shift"];

const MODIFIER_NAMES: Record<string, string> = {
  command: "Super",
  cmd: "Super",
  super: "Super",
  meta: "Super",
  control: "Ctrl",
  ctrl: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};

// Named keys keep the spelling mygo's parser knows.
const NAMED_KEYS: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  " ": "Space",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  escape: "Escape",
  esc: "Escape",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  "+": "+",
};

// CODE_KEYS names the keys whose accelerator name differs from their key code:
// punctuation, the keys that carry a name of their own, and the number pad.
const CODE_KEYS: Record<string, string> = {
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Tab: "Tab",
  Space: "Space",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Escape: "Escape",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  NumpadAdd: "NumAdd",
  NumpadSubtract: "NumSub",
  NumpadMultiply: "NumMult",
  NumpadDivide: "NumDiv",
  NumpadDecimal: "NumDec",
  AudioVolumeUp: "VolumeUp",
  AudioVolumeDown: "VolumeDown",
  AudioVolumeMute: "VolumeMute",
};

// KEYCODE_KEYS names the keys whose code the browser leaves out, as it does
// while an input method composes Option+G into "©": the virtual key is what
// remains, and it is the key mygo registers. 229 is an input method in the
// middle of a composition, which names no key at all.
const KEYCODE_KEYS: Record<number, string> = {
  8: "Backspace",
  9: "Tab",
  13: "Enter",
  27: "Escape",
  32: "Space",
  33: "PageUp",
  34: "PageDown",
  35: "End",
  36: "Home",
  37: "Left",
  38: "Up",
  39: "Right",
  40: "Down",
  45: "Insert",
  46: "Delete",
  106: "NumMult",
  107: "NumAdd",
  109: "NumSub",
  110: "NumDec",
  111: "NumDiv",
  186: ";",
  187: "=",
  188: ",",
  189: "-",
  190: ".",
  191: "/",
  192: "`",
  219: "[",
  220: "\\",
  221: "]",
  222: "'",
};

const BARE_MODIFIERS = ["Meta", "Control", "Alt", "Shift", "CapsLock", "Fn", "Dead"];

/** isModifierKey reports whether a key press is a modifier on its own, which is
 * the press the user makes before the key that names the shortcut. */
export function isModifierKey(key: string): boolean {
  return BARE_MODIFIERS.includes(key);
}

const isMac = navigator.platform.toUpperCase().includes("MAC");

/** canonical puts an accelerator in one shape, so that what the settings hold
 * and what a key press produces compare equal. */
export function canonical(accel: string): string {
  const mods = new Set<string>();
  let key = "";
  for (const raw of accel.split("+")) {
    const part = raw.trim();
    if (!part) continue;
    const lower = part.toLowerCase();
    const named = MODIFIER_NAMES[lower];
    if (named) {
      mods.add(named);
      continue;
    }
    if (lower === "commandorcontrol" || lower === "cmdorctrl") {
      mods.add(isMac ? "Super" : "Ctrl");
      continue;
    }
    key = part.length === 1 ? part.toUpperCase() : (NAMED_KEYS[lower] ?? part);
  }
  const ordered = MODIFIER_ORDER.filter((mod) => mods.has(mod));
  return [...ordered, key].join("+");
}

/** keyNameFromCode names the key the user pressed. The code is the key's
 * position, which is what mygo registers with the system, and the only name
 * left standing while Option or Shift is held: macOS hands Option+G over as
 * the character "©", which no global shortcut can be registered as. */
function keyNameFromCode(code: string): string | null {
  if (!code) return null;
  const mapped = CODE_KEYS[code];
  if (mapped) return mapped;
  let match = /^Key([A-Z])$/.exec(code);
  if (match) return match[1]!;
  match = /^Digit([0-9])$/.exec(code);
  if (match) return match[1]!;
  match = /^Numpad([0-9])$/.exec(code);
  if (match) return "Num" + match[1];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return null;
}

/** keyNameFromKeyCode names the key from the virtual key, for the presses the
 * browser reports no code for. */
function keyNameFromKeyCode(keyCode: number): string | null {
  if (keyCode >= 65 && keyCode <= 90) return String.fromCharCode(keyCode);
  if (keyCode >= 48 && keyCode <= 57) return String.fromCharCode(keyCode);
  if (keyCode >= 96 && keyCode <= 105) return "Num" + (keyCode - 96);
  if (keyCode >= 112 && keyCode <= 131) return "F" + (keyCode - 111);
  return KEYCODE_KEYS[keyCode] ?? null;
}

/** keyNameFromEvent covers the press the browser reports no code for, as on a
 * layout key an ANSI keyboard lacks. Only named keys and printable ASCII pass:
 * a composed character names no key. */
function keyNameFromEvent(event: KeyboardEvent): string | null {
  const key = event.key;
  if (/^F\d{1,2}$/.test(key)) return key;
  const named = NAMED_KEYS[key.toLowerCase()];
  if (named) return named;
  if (/^[\x20-\x7e]$/.test(key)) return key.toUpperCase();
  return null;
}

/** accelFromEvent turns a key press into an accelerator, or returns null for a
 * bare modifier, which cannot be a shortcut on its own. */
export function accelFromEvent(event: KeyboardEvent): string | null {
  const key = event.key;
  if (!key || BARE_MODIFIERS.includes(key)) return null;
  const name = keyNameFromCode(event.code) ?? keyNameFromKeyCode(event.keyCode) ?? keyNameFromEvent(event);
  if (!name) return null;
  const mods = MODIFIER_ORDER.filter(
    (mod) =>
      (mod === "Super" && event.metaKey) ||
      (mod === "Ctrl" && event.ctrlKey) ||
      (mod === "Alt" && event.altKey) ||
      (mod === "Shift" && event.shiftKey),
  );
  return [...mods, name].join("+");
}

/** hasModifier reports whether an accelerator would leave plain typing alone. */
export function hasModifier(accel: string): boolean {
  const parts = canonical(accel).split("+");
  return parts.some((part) => part === "Super" || part === "Ctrl" || part === "Alt");
}

const SYMBOLS: Record<string, string> = {
  Super: "⌘",
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Enter: "↩",
  Backspace: "⌫",
  Delete: "⌦",
  Escape: "⎋",
  Tab: "⇥",
  Space: "Space",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
};

/** formatAccel shows an accelerator the way macOS menus do, ⌘⇧P rather than
 * the Super+Shift+P the file holds. */
export function formatAccel(accel: string): string {
  const parts = canonical(accel).split("+");
  if (!isMac) return parts.join("+");
  return parts.map((part) => SYMBOLS[part] ?? part).join("");
}
