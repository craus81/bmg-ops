/**
 * Pop-out windows close on X, Cancel or Esc, never on a click outside them
 * (owner decision 2026-10-07). A stray click past the edge of a window, or a
 * text selection dragged out of it, used to close the window and throw away
 * whatever had been typed in it.
 *
 * Put `ref={closeOnEscape(close)}` on a window's backdrop. While the backdrop
 * is mounted, Esc runs `close` — for the topmost open window only, so Esc on a
 * confirm dialog over an estimate closes the dialog, not the estimate.
 *
 * A key handler inside the window that uses Esc for something smaller
 * (closing a dropdown, clearing a search box) calls `e.preventDefault()` and
 * the window stays open.
 */

const open = new Map<HTMLElement, () => void>();

function zIndexOf(el: HTMLElement): number {
  const z = parseInt(el.style.zIndex || getComputedStyle(el).zIndex, 10);
  return Number.isFinite(z) ? z : 0;
}

/** True when `b` draws above `a`. */
function isAbove(b: HTMLElement, a: HTMLElement): boolean {
  if (a.contains(b)) return true;
  if (b.contains(a)) return false;
  const za = zIndexOf(a);
  const zb = zIndexOf(b);
  if (za !== zb) return zb > za;
  return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

/** The window Esc should close, or null when none is open. */
export function topmostWindow(els: Iterable<HTMLElement>): HTMLElement | null {
  let top: HTMLElement | null = null;
  for (const el of els) if (!top || isAbove(el, top)) top = el;
  return top;
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
  const top = topmostWindow(open.keys());
  if (!top) return;
  e.preventDefault();
  open.get(top)?.();
}

let listening = false;

export function closeOnEscape(close: (() => unknown) | undefined) {
  let node: HTMLElement | null = null;
  return (el: HTMLElement | null) => {
    if (el && close) {
      node = el;
      open.set(el, () => { void close(); });
      if (!listening && typeof document !== 'undefined') {
        document.addEventListener('keydown', onKeyDown);
        listening = true;
      }
    } else if (node) {
      open.delete(node);
      node = null;
    }
  };
}
