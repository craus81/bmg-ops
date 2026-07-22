/**
 * Scroll to and briefly flash a note element after a Mentions-inbox deep
 * link lands on its record.
 *
 * Mentions carry the target note's id in their `contextUrl` (`&note=<id>`),
 * so each notes surface renders its rows with a stable DOM id (e.g.
 * `po-note-<id>`, `vnote-<id>`) and calls flashNote() from its deep-link
 * effect. Because notes load async — and often inside a modal that mounts a
 * beat later — we poll for the element instead of assuming it's there, then
 * scroll it into view and add the `.note-flash` class (a CSS pulse in
 * globals.css). The class is toggled imperatively, so a React re-render that
 * only rewrites the element's inline `style` won't clear it.
 */
export function flashNote(domId: string, opts?: { tries?: number; intervalMs?: number }): void {
  if (typeof document === 'undefined' || !domId) return;
  const tries = opts?.tries ?? 30;
  const intervalMs = opts?.intervalMs ?? 100;
  let attempt = 0;

  const run = () => {
    const el = document.getElementById(domId);
    if (!el) {
      if (attempt++ < tries) setTimeout(run, intervalMs);
      return;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Restart the animation if the same element is flashed twice in a row.
    el.classList.remove('note-flash');
    void el.offsetWidth; // force reflow so re-adding the class replays it
    el.classList.add('note-flash');
    setTimeout(() => el.classList.remove('note-flash'), 2200);
  };

  run();
}
