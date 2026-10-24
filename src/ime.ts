// The keys an input method takes for itself. A Chinese, Japanese or Korean
// keyboard keeps what the user types in a candidate window and commits it with
// Enter; that Enter is the input method's, and anything the app binds to Enter
// — a new line in the editor, the end of a rename — has to wait for the next
// one.
//
// WebKit makes this harder than it looks: it ends the composition before it
// delivers the key down that confirmed it, so that key down arrives with
// isComposing false and keyCode 229 rather than 13
// (https://bugs.webkit.org/show_bug.cgi?id=165004).

let composing = false;
let endedAt = -Infinity;

/** watchComposition follows the compositions of every field of the page: the
 * composition events do not bubble out of the field, but they do reach the
 * window in the capture phase. */
export function watchComposition(): void {
  window.addEventListener(
    "compositionstart",
    () => {
      composing = true;
    },
    true,
  );
  window.addEventListener(
    "compositionend",
    (event) => {
      composing = false;
      endedAt = event.timeStamp;
    },
    true,
  );
}

/** imeBusy reports whether a key press belongs to the input method, and not to
 * the app: the ones pressed while a candidate window is open, and the one that
 * committed it, which WebKit sends just after compositionend. */
export function imeBusy(event: KeyboardEvent): boolean {
  // 229 is what a browser reports for a key the input method took; the window
  // after compositionend covers WebKit handing over the confirming key down
  // once the composition is already over. The time comes from the events
  // themselves, which keeps the two comparable when the main thread stalls.
  return composing || event.isComposing || event.keyCode === 229 || Math.abs(event.timeStamp - endedAt) < 50;
}
