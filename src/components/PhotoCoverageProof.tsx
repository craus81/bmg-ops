'use client';

import { useEffect, useRef, useState } from 'react';
import { theme } from '@/lib/theme';
import { COVERAGE_COLORS, nextCoverageColor, type CoverageBox } from '@/lib/coverage-proof';

// Draw coverage boxes straight onto a photo of the customer's vehicle. Boxes
// are geometry + label + color only: no inches, no ft², nothing that reaches
// the quote's pricing (see src/lib/coverage-proof.ts). The estimator saves the
// flattened picture as the quote's coverage diagram, so it rides the emailed
// quote and the estimate attach with no extra plumbing.

interface Props {
  /** Public URL of the photo being annotated. */
  src: string;
  boxes: CoverageBox[];
  onChange: (boxes: CoverageBox[]) => void;
}

type Tool = 'box' | 'select';

type Drag =
  | { kind: 'draw'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'move' | 'resize'; id: string; grabX: number; grabY: number; rect: CoverageBox['rect'] };

const MIN_BOX_PX = 6;

// The drawn box exactly as it appears on screen and in the saved JPEG (see
// paintBoxes in src/lib/coverage-proof.ts): a tinted rect with a solid label
// pill, since plain colored text over a photo is unreadable.
function CoverageBoxShape({ box, photoW, stroke }: { box: CoverageBox; photoW: number; stroke?: string }) {
  const fontSize = photoW / 48;
  const label = (box.label || '').trim();
  const padX = fontSize * 0.45, padY = fontSize * 0.3;
  const pillH = fontSize + padY * 2;
  // Above the box when there's room, otherwise tucked inside its top edge.
  const pillY = box.rect.y - pillH > 0 ? box.rect.y - pillH : box.rect.y;
  return (
    <>
      <rect
        x={box.rect.x} y={box.rect.y} width={box.rect.w} height={box.rect.h}
        fill={`${box.color}33`} stroke={stroke || box.color} strokeWidth={2} vectorEffect="non-scaling-stroke"
      />
      {label && (
        <>
          {/* Canvas measures the real text width; SVG approximates it here —
              the pill is only the on-screen stand-in for the saved picture. */}
          <rect x={box.rect.x} y={pillY} width={label.length * fontSize * 0.62 + padX * 2} height={pillH} fill={box.color} rx={fontSize * 0.2} />
          <text x={box.rect.x + padX} y={pillY + pillH / 2} fill="#fff" fontSize={fontSize} fontWeight={700} dominantBaseline="middle">{label}</text>
        </>
      )}
    </>
  );
}

/**
 * Read-only render of a photo proof — used by the quote preview so an unsaved
 * quote shows the same picture the customer will get.
 */
export function CoverageProofPreview({ src, boxes }: { src: string; boxes: CoverageBox[] }) {
  const [dim, setDim] = useState<{ w: number; h: number } | null>(null);
  return (
    <div style={{ position: 'relative', marginBottom: '10px', background: '#000', border: `1px solid ${theme.border}`, borderRadius: '8px', overflow: 'hidden' }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- photo dimensions are unknown; next/image needs fixed sizes */}
      <img
        src={src}
        alt="Coverage areas"
        onLoad={e => setDim({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        style={{ width: '100%', display: 'block' }}
        draggable={false}
      />
      {dim && (
        <svg viewBox={`0 0 ${dim.w} ${dim.h}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
          {boxes.map(b => <CoverageBoxShape key={b.id} box={b} photoW={dim.w} />)}
        </svg>
      )}
    </div>
  );
}

export default function PhotoCoverageProof({ src, boxes, onChange }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dim, setDim] = useState<{ w: number; h: number } | null>(null);
  const [tool, setTool] = useState<Tool>('box');
  const [drag, setDrag] = useState<Drag | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // A different photo means different pixel dimensions — re-measure before
  // any coordinate math runs against the old ones.
  useEffect(() => { setDim(null); setSelectedId(null); setDrag(null); }, [src]);

  const selected = boxes.find(b => b.id === selectedId) || null;

  // clientX/clientY and the rect are both real viewport px, so the ratio is
  // unaffected by the app's text-size zoom.
  const photoPoint = (e: { clientX: number; clientY: number }) => {
    const svg = svgRef.current;
    if (!svg || !dim) return null;
    const r = svg.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return {
      x: (e.clientX - r.left) * (dim.w / r.width),
      y: (e.clientY - r.top) * (dim.h / r.height),
    };
  };

  const update = (id: string, patch: Partial<CoverageBox>) =>
    onChange(boxes.map(b => (b.id === id ? { ...b, ...patch } : b)));

  const remove = (id: string) => {
    onChange(boxes.filter(b => b.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const duplicate = (b: CoverageBox) => {
    const offset = dim ? Math.max(8, dim.w / 60) : 12;
    const copy: CoverageBox = {
      ...b,
      id: crypto.randomUUID(),
      rect: { ...b.rect, x: b.rect.x + offset, y: b.rect.y + offset },
    };
    onChange([...boxes, copy]);
    setSelectedId(copy.id);
  };

  const beginEdit = (e: React.PointerEvent, b: CoverageBox, kind: 'move' | 'resize') => {
    if (tool !== 'select') return;
    e.stopPropagation();
    const p = photoPoint(e);
    if (!p) return;
    setSelectedId(b.id);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({ kind, id: b.id, grabX: p.x, grabY: p.y, rect: { ...b.rect } });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (tool !== 'box' || !dim) return;
    const p = photoPoint(e);
    if (!p) return;
    setSelectedId(null);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({ kind: 'draw', x1: p.x, y1: p.y, x2: p.x, y2: p.y });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = photoPoint(e);
    if (!p) return;
    if (drag.kind === 'draw') {
      setDrag({ ...drag, x2: p.x, y2: p.y });
      return;
    }
    const dx = p.x - drag.grabX, dy = p.y - drag.grabY;
    const r = drag.rect;
    update(drag.id, drag.kind === 'move'
      ? { rect: { ...r, x: r.x + dx, y: r.y + dy } }
      : { rect: { ...r, w: Math.max(MIN_BOX_PX, r.w + dx), h: Math.max(MIN_BOX_PX, r.h + dy) } });
  };

  const onPointerUp = () => {
    if (drag?.kind === 'draw') {
      const x = Math.min(drag.x1, drag.x2), y = Math.min(drag.y1, drag.y2);
      const w = Math.abs(drag.x2 - drag.x1), h = Math.abs(drag.y2 - drag.y1);
      // A click that never became a drag is a miss, not an invisible box.
      if (w >= MIN_BOX_PX && h >= MIN_BOX_PX) {
        const box: CoverageBox = {
          id: crypto.randomUUID(),
          label: `Area ${boxes.length + 1}`,
          color: nextCoverageColor(boxes.length),
          rect: { x, y, w, h },
        };
        onChange([...boxes, box]);
        setSelectedId(box.id);
        setTool('select');
      }
    }
    setDrag(null);
  };

  // Delete removes the selected box, Esc drops the selection — but never while
  // the label field (or any other input) has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (e.key === 'Escape') { setSelectedId(null); setDrag(null); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) { e.preventDefault(); remove(selectedId); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remove() closes over the current boxes
  }, [selectedId, boxes]);

  const btn = (active: boolean, color: string) => ({
    padding: '8px 6px', borderRadius: '8px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
    background: active ? `${color}26` : 'var(--subtle-bg)',
    border: active ? `1px solid ${color}66` : '1px solid var(--border)',
    color: active ? color : 'var(--text-secondary)',
  });
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '6px 8px', borderRadius: '6px', fontSize: '11px',
    background: 'var(--input-bg)', border: `1px solid ${theme.border}`, color: 'var(--text-primary)',
  };
  const labelStyle: React.CSSProperties = { fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' };

  const previewRect = drag?.kind === 'draw'
    ? { x: Math.min(drag.x1, drag.x2), y: Math.min(drag.y1, drag.y2), w: Math.abs(drag.x2 - drag.x1), h: Math.abs(drag.y2 - drag.y1) }
    : null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '230px minmax(0, 1fr)', gap: '12px', alignItems: 'start' }}>
      {/* Tools + box list */}
      <div style={{ background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '12px' }}>
        <div style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '8px' }}>Coverage Proof</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '10px' }}>
          <button onClick={() => setTool('box')} style={btn(tool === 'box', '#06b6d4')}>Draw Box</button>
          <button onClick={() => { setTool('select'); setDrag(null); }} style={btn(tool === 'select', '#06b6d4')}>Select / Move</button>
        </div>

        <div style={{ padding: '8px', borderRadius: '8px', background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.25)', fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '10px', lineHeight: 1.5 }}>
          {tool === 'box'
            ? <>Drag a box over each area being wrapped. Name it and set its color on the right — the boxes are a <b>picture for the customer</b>, they don&apos;t measure or price anything.</>
            : <>Drag a box to move it, drag its bottom-right corner to resize, <b>Delete</b> to remove it.</>}
        </div>

        <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>
          Boxes ({boxes.length})
        </div>
        {boxes.length === 0 && <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '8px' }}>Nothing drawn yet.</div>}
        {boxes.map(b => (
          <div key={b.id} onClick={() => { setSelectedId(b.id); setTool('select'); }} style={{
            display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 6px', marginBottom: '3px', borderRadius: '6px', cursor: 'pointer',
            background: b.id === selectedId ? 'rgba(245,158,11,0.12)' : 'var(--subtle-bg)',
            border: `1px solid ${b.id === selectedId ? 'rgba(245,158,11,0.4)' : 'transparent'}`,
          }}>
            <span style={{ width: '10px', height: '10px', borderRadius: '3px', background: b.color, flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.label || 'Untitled'}</span>
            <button onClick={e => { e.stopPropagation(); remove(b.id); }} title="Delete" style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>✕</button>
          </div>
        ))}

        {selected && (
          <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: `1px solid ${theme.border}` }}>
            <div style={labelStyle}>Label</div>
            <input
              value={selected.label}
              onChange={e => update(selected.id, { label: e.target.value })}
              placeholder="Driver side, Hood, …"
              style={{ ...inputStyle, marginBottom: '8px' }}
            />
            <div style={labelStyle}>Color</div>
            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '8px' }}>
              {COVERAGE_COLORS.map(c => (
                <button
                  key={c}
                  onClick={() => update(selected.id, { color: c })}
                  title={c}
                  style={{
                    width: '20px', height: '20px', borderRadius: '5px', background: c, cursor: 'pointer',
                    border: c === selected.color ? '2px solid var(--text-primary)' : '1px solid var(--border)',
                  }}
                />
              ))}
            </div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <button onClick={() => duplicate(selected)} style={{ padding: '5px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, cursor: 'pointer', background: 'rgba(6,182,212,0.08)', border: '1px solid #06b6d4', color: '#06b6d4' }}>⧉ Duplicate</button>
              <button onClick={() => remove(selected.id)} style={{ padding: '5px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, cursor: 'pointer', background: 'transparent', border: '1px solid #ef4444', color: '#ef4444' }}>Delete</button>
            </div>
          </div>
        )}
      </div>

      {/* Photo canvas */}
      <div style={{ position: 'relative', background: '#000', border: `1px solid ${theme.border}`, borderRadius: '12px', overflow: 'hidden' }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- photo dimensions are unknown; next/image needs fixed sizes */}
        <img
          src={src}
          alt="Vehicle photo"
          onLoad={e => setDim({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          style={{ width: '100%', display: 'block' }}
          draggable={false}
        />
        {dim && (
          <svg
            ref={svgRef}
            viewBox={`0 0 ${dim.w} ${dim.h}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: tool === 'box' ? 'crosshair' : 'default', touchAction: 'none' }}
          >
            {boxes.map(b => {
              const sel = b.id === selectedId;
              return (
                <g key={b.id} onPointerDown={e => beginEdit(e, b, 'move')} style={{ cursor: tool === 'select' ? 'move' : 'crosshair' }}>
                  <CoverageBoxShape box={b} photoW={dim.w} stroke={sel ? '#f59e0b' : undefined} />
                  {sel && tool === 'select' && (
                    <rect
                      x={b.rect.x + b.rect.w - dim.w / 90} y={b.rect.y + b.rect.h - dim.w / 90}
                      width={dim.w / 45} height={dim.w / 45}
                      fill="#f59e0b" stroke="#fff" strokeWidth={1} vectorEffect="non-scaling-stroke"
                      onPointerDown={e => beginEdit(e, b, 'resize')}
                      style={{ cursor: 'nwse-resize' }}
                    />
                  )}
                </g>
              );
            })}
            {previewRect && previewRect.w > 0 && (
              <rect
                x={previewRect.x} y={previewRect.y} width={previewRect.w} height={previewRect.h}
                fill="rgba(6,182,212,0.18)" stroke="#06b6d4" strokeWidth={2} strokeDasharray="6 4" vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
        )}
      </div>
    </div>
  );
}
