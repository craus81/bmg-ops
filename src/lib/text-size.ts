// App-wide text size (Regular / Large / XL), applied as CSS `zoom` on <body>
// via the data-textsize attribute on <html> (see globals.css). Zoom scales
// every px-sized style proportionally — text, icons, paddings — and reflows
// layout, so grids wrap to fewer, bigger cards instead of clipping.
//
// IMPORTANT: zoom also multiplies viewport units, so inline styles must never
// use bare vh/vw lengths — write `calc(90vh / var(--ts))` so the zoom
// multiplies it back to exactly 90% of the real viewport. `--ts` is defined
// in globals.css and always resolves (1 at Regular).

export type TextSize = 'regular' | 'large' | 'xl';

export const TEXT_SIZE_ZOOM: Record<TextSize, number> = {
  regular: 1,
  large: 1.15,
  xl: 1.3,
};

export const TEXT_SIZE_STORAGE_KEY = 'bmg-text-size';

export function isTextSize(v: unknown): v is TextSize {
  return v === 'regular' || v === 'large' || v === 'xl';
}

/**
 * The zoom factor currently applied to <body>. JS that mixes real viewport
 * pixels (clientX/clientY, window.innerWidth/innerHeight) with CSS pixels
 * inside the zoomed page (style left/top, offsetWidth) must divide the real
 * px by this factor — see the AiChat drag handling.
 */
export function getTextZoom(): number {
  if (typeof document === 'undefined') return 1;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--ts');
  const z = parseFloat(raw);
  return Number.isFinite(z) && z > 0 ? z : 1;
}
