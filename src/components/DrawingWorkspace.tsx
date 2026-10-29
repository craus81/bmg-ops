'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { theme } from '@/lib/theme';

// The frame around a wrap quote drawing editor (vehicle template, customer
// proof, photos): side panel + picture on the page, or the picture full
// screen with small tool buttons and the panel as a sheet that slides over
// it. Both layouts render the same elements in the same places, so going in
// and out of full screen keeps everything — half-drawn shapes, zoom, the
// selected box — and nothing has to be saved first.

/** Turn-your-phone hint, once dismissed, stays away for the visit. */
let rotateHintDismissed = false;

/** Phone or tablet held sideways — the panel docks to the right instead. */
function useLandscape(active: boolean): boolean {
  const [landscape, setLandscape] = useState(false);
  useEffect(() => {
    if (!active) return;
    const check = () => setLandscape(window.innerWidth > window.innerHeight);
    check();
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);
    return () => {
      window.removeEventListener('resize', check);
      window.removeEventListener('orientationchange', check);
    };
  }, [active]);
  return landscape;
}

/** Narrow screen (a phone held upright): the page layout stacks. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    // Media queries see real px, so the text-size zoom doesn't skew this.
    const mq = window.matchMedia('(max-width: 700px)');
    const check = () => setNarrow(mq.matches);
    check();
    mq.addEventListener('change', check);
    return () => mq.removeEventListener('change', check);
  }, []);
  return narrow;
}

interface Props {
  fullscreen: boolean;
  onFullscreenChange: (on: boolean) => void;
  /** The side panel: tools, scale, the list of boxes, the selected box's fields. */
  panel: ReactNode;
  /** Full screen only: whether the panel sheet is showing. */
  panelOpen: boolean;
  onPanelOpenChange: (open: boolean) => void;
  /** Heading on the panel sheet — the selected box's name, or what the panel holds. */
  panelTitle?: ReactNode;
  /** Page layout columns, panel first. Stacks on a phone. */
  inlineColumns: string;
  /** Page only: shown above the picture (zoom row, warnings). */
  inlineHeader?: ReactNode;
  /** Page only: shown under the picture (totals bar). */
  inlineFooter?: ReactNode;
  /** The picture. In full screen it sits in a box that fills the space left
   *  (a size container, so the picture can fit itself with cq units). */
  canvas: ReactNode;
  /** Full screen top bar: the tool buttons. */
  tools: ReactNode;
  /** Full screen top bar, right side: zoom buttons. */
  zoomControls?: ReactNode;
  /** Full screen bottom bar: the selected box's quick fields, or photo nav. */
  bottomBar?: ReactNode;
  /** Full screen: what to do next, floated over the top of the picture. */
  hint?: ReactNode;
  /** Picture width ÷ height — a wide one on an upright phone gets the turn hint. */
  pictureAspect?: number | null;
}

export default function DrawingWorkspace({
  fullscreen, onFullscreenChange, panel, panelOpen, onPanelOpenChange, panelTitle, inlineColumns,
  inlineHeader, inlineFooter, canvas, tools, zoomControls, bottomBar, hint, pictureAspect,
}: Props) {
  const landscape = useLandscape(fullscreen);
  const narrow = useNarrow();
  const [hintGone, setHintGone] = useState(rotateHintDismissed);

  // Keep the page behind from scrolling, and the app's bottom bar from
  // peeking through, while the picture has the screen.
  useEffect(() => {
    if (!fullscreen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [fullscreen]);

  const showRotateHint = fullscreen && !panelOpen && !landscape && !hintGone && (pictureAspect || 0) > 1.3
    && typeof window !== 'undefined' && Math.min(window.innerWidth, window.innerHeight) < 600;

  const rootStyle: React.CSSProperties = fullscreen
    ? {
      position: 'fixed', inset: 0, zIndex: 3000, background: '#0b0f17',
      display: 'flex', flexDirection: landscape ? 'row' : 'column',
      paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)',
      paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)',
    }
    : { display: 'grid', gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : inlineColumns, gap: '12px', alignItems: 'start' };

  const panelStyle: React.CSSProperties = fullscreen
    ? {
      display: panelOpen ? 'flex' : 'none', flexDirection: 'column', order: 2, flexShrink: 0,
      background: 'var(--card)', overflow: 'hidden',
      ...(landscape
        ? { width: 'min(360px, 45%)', borderLeft: `1px solid ${theme.border}` }
        : { maxHeight: '55%', borderTop: `1px solid ${theme.border}`, borderRadius: '16px 16px 0 0' }),
    }
    // Upright phone: the picture first, its panel under it.
    : { order: narrow ? 2 : 0, minWidth: 0 };

  const stageStyle: React.CSSProperties = fullscreen
    ? { order: 1, flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }
    : { order: 1, minWidth: 0 };

  const barBtn: React.CSSProperties = {
    height: '34px', padding: '0 8px', borderRadius: '9px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
    background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.18)', color: '#e5e7eb', flexShrink: 0,
  };

  return (
    <div style={rootStyle} className={fullscreen ? 'duo-clear-status' : undefined}>
      <div style={panelStyle}>
        {fullscreen && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', borderBottom: `1px solid ${theme.border}`, flexShrink: 0 }}>
            <div style={{ flex: 1, minWidth: 0, fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {panelTitle}
            </div>
            <button
              onClick={() => onPanelOpenChange(false)}
              style={{ ...barBtn, height: '30px', background: 'rgba(6,182,212,0.12)', border: '1px solid rgba(6,182,212,0.4)', color: '#06b6d4' }}
            >{landscape ? 'Back to drawing ▸' : 'Back to drawing ▾'}</button>
          </div>
        )}
        <div style={fullscreen ? { overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: '8px', minHeight: 0 } : undefined}>
          {panel}
        </div>
      </div>

      <div style={stageStyle}>
        {fullscreen ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '6px', flexShrink: 0, overflowX: 'auto' }}>
            <button onClick={() => onFullscreenChange(false)} title="Back to the page — everything you drew stays" style={barBtn}>✕ Done</button>
            <div style={{ display: 'flex', gap: '3px', marginLeft: '2px' }}>{tools}</div>
            <div style={{ display: 'flex', gap: '3px', marginLeft: 'auto', paddingLeft: '4px' }}>{zoomControls}</div>
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '6px' }}>
              <button
                onClick={() => onFullscreenChange(true)}
                title="Make the picture fill the screen, with small tool buttons — easier to draw on a phone or tablet"
                style={{
                  padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 800, cursor: 'pointer',
                  background: 'rgba(6,182,212,0.12)', border: '1px solid rgba(6,182,212,0.4)', color: '#06b6d4',
                }}
              >⛶ Full screen</button>
            </div>
            {inlineHeader}
          </div>
        )}

        <div style={fullscreen ? { flex: 1, minHeight: 0, position: 'relative', containerType: 'size', display: 'flex' } : undefined}>
          {canvas}
          {fullscreen && hint && (
            <div style={{
              position: 'absolute', top: '8px', left: '50%', transform: 'translateX(-50%)', maxWidth: 'calc(100% - 24px)',
              padding: '6px 12px', borderRadius: '14px', background: 'rgba(6,182,212,0.92)', color: '#022c33',
              fontSize: '12px', fontWeight: 700, textAlign: 'center', pointerEvents: 'none', zIndex: 2, lineHeight: 1.35,
            }}>{hint}</div>
          )}
          {showRotateHint && (
            <div style={{
              position: 'absolute', bottom: '8px', left: '50%', transform: 'translateX(-50%)', maxWidth: 'calc(100% - 24px)',
              display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 6px 6px 12px', borderRadius: '14px',
              background: 'rgba(15,23,42,0.92)', border: '1px solid rgba(255,255,255,0.2)', color: '#e5e7eb',
              fontSize: '12px', fontWeight: 700, zIndex: 2,
            }}>
              <span>↻ Turn your phone sideways for a bigger picture</span>
              <button
                onClick={() => { rotateHintDismissed = true; setHintGone(true); }}
                aria-label="Dismiss"
                style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: '14px', fontWeight: 700, cursor: 'pointer', padding: '2px 6px' }}
              >✕</button>
            </div>
          )}
        </div>

        {fullscreen && bottomBar && !panelOpen && (
          <div style={{ padding: '6px 8px', flexShrink: 0 }}>{bottomBar}</div>
        )}
        {!fullscreen && inlineFooter}
      </div>
    </div>
  );
}

/** A small icon-and-word button for the full screen tool bar. */
export function ToolButton({ icon, label, active, onClick, disabled, title, color = '#06b6d4' }: {
  icon: ReactNode; label: string; active?: boolean; onClick: () => void; disabled?: boolean; title?: string; color?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title || label}
      aria-label={label}
      aria-pressed={!!active}
      style={{
        width: '40px', height: '40px', padding: '2px 0 0', borderRadius: '9px', flexShrink: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1px',
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1,
        background: active ? `${color}33` : 'rgba(255,255,255,0.08)',
        border: `1px solid ${active ? color : 'rgba(255,255,255,0.18)'}`,
        color: active ? color : '#e5e7eb',
      }}
    >
      <span style={{ fontSize: '15px', lineHeight: 1 }}>{icon}</span>
      <span style={{ fontSize: '9px', fontWeight: 700, lineHeight: 1.1 }}>{label}</span>
    </button>
  );
}

/** Zoom / nav buttons in the full screen bars. */
export const barButtonStyle: React.CSSProperties = {
  minWidth: '32px', height: '34px', padding: '0 6px', borderRadius: '9px', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
  background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.18)', color: '#e5e7eb', flexShrink: 0,
};

/** The selected box's quick fields along the bottom of full screen. */
export function QuickBar({ color, title, detail, onClose, children }: { color?: string; title: ReactNode; detail?: ReactNode; onClose?: () => void; children: ReactNode }) {
  return (
    <div style={{ background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '7px 9px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px', minWidth: 0 }}>
        {color && <span style={{ width: '10px', height: '10px', borderRadius: '3px', background: color, flexShrink: 0 }} />}
        <span style={{ flex: 1, minWidth: 0, fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        {detail && <span style={{ flexShrink: 0, fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)' }}>{detail}</span>}
        {onClose && (
          <button onClick={onClose} aria-label="Deselect" title="Deselect" style={{ flexShrink: 0, background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '14px', fontWeight: 700, cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}>✕</button>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>{children}</div>
    </div>
  );
}
