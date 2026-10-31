'use client';

/**
 * One Save, always in reach (Craig, 2026-10-29): a slim bar pinned just under
 * the sticky BMG header while the page scrolls, with Save and Cancel. It
 * replaces the Save/Cancel that used to sit at the bottom of the form, so
 * there's only one Save to pick. Green, like the Save buttons it replaced.
 * Inside a modal pass `inModal`: it becomes the modal's own header row and
 * pins to the top of the modal's scroll area instead.
 *
 * The leave button says "Leave without saving" (Craig, 2026-10-31): it only
 * drops unsaved edits; it never cancels, closes, or deletes the order. On a
 * narrow phone it wraps to two short lines instead of crowding Save.
 *
 * On the Duo small screen the bar lives in the page column, left of the side
 * rail, so the clock bubble over the rail never covers Save.
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';

/** Height of the sticky app header the bar tucks under (0 when it isn't sticky). */
export function stickyHeaderOffset(header: { offsetHeight: number } | null, position: string | null): number {
  if (!header || position !== 'sticky') return 0;
  return header.offsetHeight;
}

function useHeaderOffset(enabled: boolean) {
  const [top, setTop] = useState(0);
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;
    const header = document.querySelector<HTMLElement>('.app-header');
    if (!header) return;
    const measure = () => setTop(stickyHeaderOffset(header, getComputedStyle(header).position));
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(header);
    window.addEventListener('resize', measure);
    return () => { ro?.disconnect(); window.removeEventListener('resize', measure); };
  }, [enabled]);
  return top;
}

/** The bar's leave button (Craig 2026-10-31: not "Cancel", which read like canceling the order). */
export const LEAVE_WITHOUT_SAVING = 'Leave without saving';

/** Joins the last two words so a squeezed button wraps to two lines, never three. */
export function twoLineLabel(label: string): string {
  return label.replace(/ (\S+)$/, '\u00a0$1');
}

/** For a bar that opens a 16px-padded page card: spans the card edge to edge. */
export const CARD_BAR: CSSProperties = {
  margin: '-16px -16px 12px', background: 'var(--card)', borderRadius: '14px 14px 0 0',
};

export default function TopSaveBar({
  title, subtitle, onSave, saving = false, disabled = false,
  saveLabel = 'Save', savingLabel = 'Saving…', onCancel, cancelLabel = LEAVE_WITHOUT_SAVING,
  inModal = false, extra, style, error,
}: {
  /** What's being edited, e.g. "Estimate #1234". */
  title?: ReactNode;
  subtitle?: ReactNode;
  onSave: () => void;
  saving?: boolean;
  disabled?: boolean;
  saveLabel?: string;
  savingLabel?: string;
  onCancel?: () => void;
  cancelLabel?: string;
  inModal?: boolean;
  /** Any other button that belongs beside Save (kept to one). */
  extra?: ReactNode;
  /** Why the last save failed, in red under the title. */
  error?: ReactNode;
  /** Placement tweaks, e.g. a negative margin to span a padded modal. */
  style?: CSSProperties;
}) {
  const headerTop = useHeaderOffset(!inModal);
  const off = saving || disabled;
  return (
    <div
      data-top-save-bar
      style={{
        position: 'sticky', top: inModal ? 0 : headerTop, zIndex: 40,
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: inModal ? '12px 18px' : '8px 12px', margin: inModal ? 0 : '0 0 12px',
        background: inModal ? 'var(--card)' : 'var(--bg)', borderBottom: '1px solid var(--border)',
        borderRadius: inModal ? '14px 14px 0 0' : '0 0 10px 10px',
        boxShadow: '0 4px 10px rgba(0,0,0,0.12)',
        ...style,
      }}
    >
      <div style={{ flex: 1, minWidth: 0, lineHeight: 1.25 }}>
        {title && (
          <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title}
          </div>
        )}
        {error && (
          <div role="alert" style={{ fontSize: '12px', fontWeight: 700, color: 'var(--error, #ef4444)', whiteSpace: 'pre-wrap' }}>
            {error}
          </div>
        )}
        {subtitle && !error && (
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {subtitle}
          </div>
        )}
      </div>
      {extra}
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          style={{
            padding: '8px 12px', borderRadius: '10px', background: 'transparent',
            border: '1px solid var(--border)', color: 'var(--text-body, var(--text-secondary))',
            fontWeight: 700, fontSize: '13px', cursor: 'pointer',
            // One line on a computer; two short lines on a phone (min-width wins).
            maxWidth: 'min(170px, calc(30vw / var(--ts, 1)))', minWidth: 'min-content', lineHeight: 1.15, textAlign: 'center',
          }}
        >
          {twoLineLabel(cancelLabel)}
        </button>
      )}
      <button
        type="button"
        onClick={onSave}
        disabled={off}
        style={{
          padding: '8px 16px', borderRadius: '10px', background: '#22c55e', color: '#fff',
          border: 'none', fontWeight: 800, fontSize: '13px', whiteSpace: 'nowrap',
          cursor: off ? 'default' : 'pointer', opacity: off ? 0.5 : 1,
        }}
      >
        {saving ? savingLabel : saveLabel}
      </button>
    </div>
  );
}
