// The settings, drawn over the panel as macOS draws its own: a list of
// sections on the left, the settings of the chosen one on the right. Everything
// here is a call into Go's Preferences, which writes settings.json and puts the
// changes that reach past the page in place.
import { Preferences, events, type AppInfo, type Settings, type ShortcutDef } from "./mygo";
import { accelFromEvent, formatAccel, hasModifier, isModifierKey } from "./shortcuts";

export type SettingsSection = "general" | "shortcuts" | "appearance" | "about";

export interface SettingsCallbacks {
  /** A setting changed: the panel follows it. */
  onSettings(settings: Settings): void;
  /** The notes moved to another directory and have to be read again. */
  onDataDirChanged(): void;
  /** The settings closed: the panel takes the keyboard back. */
  onClose(): void;
}

export interface SettingsUI {
  open(section?: SettingsSection): Promise<void>;
  close(): void;
  isOpen(): boolean;
}

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "general", label: "General" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "appearance", label: "Appearance" },
  { id: "about", label: "About" },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function row(label: string): { row: HTMLElement; side: HTMLElement } {
  const line = el("div", "settings-row");
  line.append(el("span", "settings-label", label));
  const side = el("div", "settings-value");
  line.append(side);
  return { row: line, side };
}

function checkbox(checked: boolean, onChange: (checked: boolean) => void): HTMLInputElement {
  const input = el("input");
  input.type = "checkbox";
  input.className = "switch";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  return input;
}

export function createSettings(host: HTMLElement, callbacks: SettingsCallbacks): SettingsUI {
  host.className = "settings";
  host.hidden = true;

  const nav = el("aside", "settings-nav");
  const title = el("h1", "settings-title", "Settings");
  nav.append(title);
  const navButtons = new Map<SettingsSection, HTMLButtonElement>();
  for (const section of SECTIONS) {
    const button = el("button", "settings-nav-item", section.label);
    button.addEventListener("click", () => show(section.id));
    navButtons.set(section.id, button);
    nav.append(button);
  }
  const done = el("button", "settings-done", "Done");
  done.addEventListener("click", () => close());
  nav.append(done);

  const body = el("div", "settings-body");
  const pages = new Map<SettingsSection, HTMLElement>();
  for (const section of SECTIONS) {
    const page = el("section", "settings-page");
    page.dataset.section = section.id;
    pages.set(section.id, page);
    body.append(page);
  }
  const panel = el("div", "settings-panel");
  panel.append(nav, body);
  host.append(panel);

  // A click on the scrim, outside the card, closes the settings.
  host.addEventListener("click", (event) => {
    if (event.target === host) close();
  });

  let current: SettingsSection = "general";

  // ---- General ----

  const general = pages.get("general")!;
  general.append(el("h2", "settings-heading", "General"));

  const loginRow = row("Open at login");
  const loginBox = checkbox(false, async (checked) => {
    try {
      await Preferences.setOpenAtLogin(checked);
    } catch (err) {
      loginBox.checked = !checked;
      showError(err, general);
    }
    await refresh();
  });
  loginRow.side.append(loginBox);
  general.append(loginRow.row);

  // The path is long: it gets its own line under the label, with the buttons
  // after it, rather than squeezing the label into two words.
  const dirRow = el("div", "settings-row settings-row-stacked");
  const dirPath = el("code", "settings-path");
  const changeDir = el("button", "settings-button", "Change…");
  const reveal = el("button", "settings-button", "Reveal");
  const dirLine = el("div", "settings-path-line");
  dirLine.append(dirPath, changeDir, reveal);
  dirRow.append(el("span", "settings-label", "Save location"), dirLine);
  general.append(dirRow);

  changeDir.addEventListener("click", async () => {
    changeDir.disabled = true;
    try {
      const before = await Preferences.get();
      const after = await Preferences.chooseDataDir();
      callbacks.onSettings(after);
      if (after.notesDir !== before.notesDir) {
        callbacks.onDataDirChanged();
        return;
      }
      await refresh();
    } catch (err) {
      showError(err, general);
    } finally {
      changeDir.disabled = false;
    }
  });

  reveal.addEventListener("click", () => void Preferences.revealDataDir());

  // ---- Shortcuts ----

  const shortcuts = pages.get("shortcuts")!;
  shortcuts.append(el("h2", "settings-heading", "Shortcuts"));
  const shortcutRows = el("div", "settings-rows");
  shortcuts.append(shortcutRows);
  // Reset All belongs at the bottom right of the card, away from the row it
  // would otherwise touch.
  const shortcutFoot = el("div", "settings-page-foot");
  const resetAll = el("button", "settings-button", "Reset All");
  shortcutFoot.append(resetAll);
  shortcuts.append(shortcutFoot);

  let defs: ShortcutDef[] = [];
  let recording: { action: string; button: HTMLButtonElement; error: HTMLElement; previous: string } | null = null;

  const renderShortcuts = (settings: Settings) => {
    shortcutRows.replaceChildren(
      ...defs.map((def) => {
        const line = el("div", "settings-row");
        const label = el("span", "settings-label", def.label);
        const side = el("div", "settings-value");
        const key = el("button", "key-button", formatAccel(settings.shortcuts[def.action] ?? def.default));
        const error = el("span", "settings-error");
        const reset = el("button", "settings-icon", "↺");
        reset.title = "Reset to " + formatAccel(def.default);
        reset.addEventListener("click", async () => {
          try {
            await Preferences.resetShortcut(def.action);
          } catch (err) {
            error.textContent = message(err);
          }
          await refresh();
        });
        key.addEventListener("click", () => startRecording(def.action, key, error));
        side.append(key, reset);
        line.append(label, side, error);
        return line;
      }),
    );
  };

  const stopRecording = (restore = true) => {
    if (!recording) return;
    recording.button.classList.remove("recording");
    if (restore) recording.button.textContent = recording.previous;
    recording = null;
    // The system may have the shortcut in hand again: a recording of the key it
    // holds would otherwise hide the panel the user is typing in.
    void Preferences.setRecording(false).catch(() => {});
  };

  /** finishRecording ends the recording with the key that ended it, and shows
   * that key at once: waiting for the settings to be read back leaves
   * "Press keys…" in the row that the key already answered. */
  const finishRecording = (accel?: string) => {
    if (!recording) return;
    const button = recording.button;
    stopRecording(accel === undefined);
    if (accel !== undefined) {
      button.textContent = formatAccel(accel);
      button.blur();
    }
  };

  const startRecording = (action: string, button: HTMLButtonElement, error: HTMLElement) => {
    stopRecording();
    recording = { action, button, error, previous: button.textContent ?? "" };
    error.textContent = "";
    button.textContent = "Press keys…";
    button.classList.add("recording");
    void Preferences.setRecording(true).catch(() => {});
  };

  // A recording ends where the keystroke would: with the panel gone or the
  // keyboard elsewhere, no key can reach the row that waits for one.
  events.panelHidden.on(() => stopRecording());
  window.addEventListener("blur", () => stopRecording());

  resetAll.addEventListener("click", async () => {
    try {
      await Preferences.resetShortcuts();
    } catch (err) {
      showError(err, shortcuts);
    }
    await refresh();
  });

  // Window capture is the first place a key press can be read, before the
  // editor and the panel look at it: while the row waits for a key, the key is
  // the row's.
  window.addEventListener(
    "keydown",
    async (event) => {
      if (!recording) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        stopRecording();
        return;
      }
      if (isModifierKey(event.key)) return;
      const accel = accelFromEvent(event);
      if (!accel) {
        // The key arrived and named nothing the accelerator knows: say so,
        // rather than leave the row waiting as if nothing had been pressed.
        recording.error.textContent = `${event.key} cannot be a shortcut`;
        return;
      }
      if (!hasModifier(accel)) {
        recording.error.textContent = "Add ⌘, ⌃ or ⌥ to the shortcut";
        return;
      }
      const action = recording.action;
      const error = recording.error;
      try {
        await Preferences.setShortcut(action, accel);
      } catch (err) {
        finishRecording();
        error.textContent = message(err);
        return;
      }
      finishRecording(accel);
      try {
        await refresh();
      } catch (err) {
        showError(err, shortcuts);
      }
    },
    true,
  );

  // ---- Appearance ----

  const appearance = pages.get("appearance")!;
  appearance.append(el("h2", "settings-heading", "Appearance"));

  const opacityRow = row("Opacity");
  const opacity = el("input", "slider");
  opacity.type = "range";
  opacity.min = "40";
  opacity.max = "100";
  opacity.step = "5";
  const opacityValue = el("span", "settings-number", "100%");
  opacityRow.side.append(opacity, opacityValue);
  appearance.append(opacityRow.row);

  let opacityTimer = 0;
  const applyOpacity = (percent: number) => {
    opacityValue.textContent = `${percent}%`;
    window.clearTimeout(opacityTimer);
    // The panel follows the slider while it moves; settings.json keeps the
    // value the user stopped at.
    opacityTimer = window.setTimeout(() => void Preferences.setOpacity(percent / 100), 180);
  };
  opacity.addEventListener("input", () => applyOpacity(Number(opacity.value)));
  opacity.addEventListener("change", () => void Preferences.setOpacity(Number(opacity.value) / 100));

  // ---- About ----

  const about = pages.get("about")!;
  about.append(el("h2", "settings-heading", "About"));
  const aboutName = el("p", "settings-about-name");
  const aboutVersion = el("p", "settings-about-version");
  // The notes live where General says they do: About tells their name and
  // version, and nothing twice.
  about.append(aboutName, aboutVersion);

  // ---- filling in ----

  const showError = (err: unknown, page: HTMLElement) => {
    const line = el("p", "settings-error", message(err));
    page.append(line);
    window.setTimeout(() => line.remove(), 4000);
  };

  async function refresh() {
    const [settings, list, info] = await Promise.all([Preferences.get(), Preferences.shortcuts(), Preferences.about()]);
    defs = list;
    loginBox.checked = settings.openAtLogin;
    dirPath.textContent = info.dataDir;
    dirPath.title = info.dataDir;
    renderShortcuts(settings);
    const percent = Math.round(settings.opacity * 100);
    opacity.value = String(percent);
    opacityValue.textContent = `${percent}%`;
    aboutName.textContent = info.name;
    aboutVersion.textContent = "Version " + (info.version || "0.1.0");
    callbacks.onSettings(settings);
  }

  function show(section: SettingsSection) {
    current = section;
    for (const [id, button] of navButtons) button.classList.toggle("active", id === section);
    for (const [id, page] of pages) page.hidden = id !== section;
  }

  function close() {
    stopRecording();
    host.hidden = true;
    callbacks.onClose();
  }

  document.addEventListener("keydown", (event) => {
    if (host.hidden || recording) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });

  return {
    async open(section) {
      host.hidden = false;
      if (section) current = section;
      show(current);
      await refresh();
    },
    close,
    isOpen: () => !host.hidden,
  };
}

function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  // mygo names the key it turned down, which the page never showed the user.
  if (text.includes("cannot be used in a global shortcut")) {
    return "This key cannot be used for a shortcut that works in every app";
  }
  // The system refuses a shortcut another app already holds, and macOS gives
  // no way to ask which one: say what the user can act on.
  if (text.includes("cannot register shortcut")) {
    return "Another app on this Mac already uses this shortcut";
  }
  return text;
}
