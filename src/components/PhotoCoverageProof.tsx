'use client';

import { useEffect, useRef, useState } from 'react';
import { theme } from '@/lib/theme';
import {
  COVERAGE_COLORS,
  nextCoverageColor,
  boxCaption,
  measureBoxes,
  type CoverageBox,
  type PhotoProof,
} from '@/lib/coverage-proof';
import {
  calibrationDisagreementPct,
  isCalibrated,
  pxPerInch,
  sqft,
  DISAGREEMENT_WARN_PCT,
  type PhotoCalibration,
  type Point,
} from '@/lib/photo-scale';

// Draw coverage boxes onto a photo of what's being covered — a vehicle, or a
// building's storefront, windows and doors — and, once the photo is
// calibrated, measure them. See src/lib/photo-scale.ts for what a single
// reference can honestly tell you; the short version is that it has to sit
// on the same face, at the same distance, as the thing being measured.

export interface ProofFilmOption {
  id: string;
  label: string;
  ratePerSqft: number;
}

interface Props {
  /** Public URL of the photo being annotated. */
  src: string;
  proof: PhotoProof;
  /** Patch the active photo (boxes and/or calibration). */
  onChange: (patch: Partial<PhotoProof>) => void;
  films: ProofFilmOption[];
  /** Film given to newly drawn boxes — the last one the user picked. */
  defaultFilmId?: string | null;
  onPickFilm?: (filmId: string | null) => void;
}

type Tool = 'box' | 'select' | 'calibrate-line' | 'calibrate-plane';

type Drag =
  | { kind: 'draw'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'calib-line'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'move' | 'resize'; id: string; grabX: number; grabY: number; rect: CoverageBox['rect'] };

const MIN_BOX_PX = 6;

// The drawn box exactly as it appears on screen and in the saved JPEG (see
// paintBoxes in src/lib/coverage-proof.ts): a tinted rect with a solid label
// pill, since plain colored text over a photo is unreadable.
function CoverageBoxShape({ box, photoW, stroke }: { box: CoverageBox; photoW: number; stroke?: string }) {
  const fontSize = photoW / 48;
  const label = boxCaption(box);
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
 * Read-only render of one photo proof — used by the quote preview so an
 * unsaved quote shows the same picture the customer will get.
 */
export function CoverageProofPreview({ src, boxes, caption }: { src: string; boxes: CoverageBox[]; caption?: string }) {
  const [dim, setDim] = useState<{ w: number; h: number } | null>(null);
  return (
    <div style={{ marginBottom: '10px' }}>
      {caption && (
        <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>{caption}</div>
      )}
      <div style={{ position: 'relative', background: '#000', border: `1px solid ${theme.border}`, borderRadius: '8px', overflow: 'hidden' }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- photo dimensions are unknown; next/image needs fixed sizes */}
        <img
          src={src}
          alt={caption || 'Coverage areas'}
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
    </div>
  );
}

export default function PhotoCoverageProof({ src, proof, onChange, films, defaultFilmId, onPickFilm }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dim, setDim] = useState<{ w: number; h: number } | null>(null);
  const [tool, setTool] = useState<Tool>('box');
  const [drag, setDrag] = useState<Drag | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Calibration in progress: a dragged line awaiting its length, or corners
  // being clicked around a known rectangle.
  const [lineDraft, setLineDraft] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [cornerDraft, setCornerDraft] = useState<Point[]>([]);
  const [lineInches, setLineInches] = useState('');
  const [planeW, setPlaneW] = useState('');
  const [planeH, setPlaneH] = useState('');

  const boxes = proof.boxes;
  const cal = proof.calibration || null;
  const calibrated = isCalibrated(cal);

  // A different photo means different pixel dimensions and a different scale —
  // drop anything half-drawn before coordinates from the old one are reused.
  useEffect(() => {
    setDim(null); setSelectedId(null); setDrag(null);
    setLineDraft(null); setCornerDraft([]); setLineInches(''); setPlaneW(''); setPlaneH('');
    setTool('box');
  }, [proof.id]);

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

  /** Any write to the boxes re-measures them against the current scale. */
  const writeBoxes = (next: CoverageBox[]) => onChange({ boxes: measureBoxes(next, cal) });

  const update = (id: string, patch: Partial<CoverageBox>) =>
    writeBoxes(boxes.map(b => (b.id === id ? { ...b, ...patch } : b)));

  /** Typed dimensions win over the photo until the user hands it back. */
  const typeDimension = (id: string, field: 'width_in' | 'height_in', value: string) => {
    const n = parseFloat(value);
    const box = boxes.find(b => b.id === id);
    if (!box) return;
    const next: CoverageBox = {
      ...box,
      manual: true,
      measured_by: null,
      [field]: Number.isFinite(n) && n > 0 ? n : null,
    };
    // A typed pair is a plain rectangle — no perspective to account for.
    next.area_in2 = next.width_in && next.height_in ? next.width_in * next.height_in : null;
    onChange({ boxes: boxes.map(b => (b.id === id ? next : b)) });
  };

  const revertToMeasured = (id: string) =>
    onChange({ boxes: measureBoxes(boxes.map(b => (b.id === id ? { ...b, manual: false } : b)), cal) });

  const remove = (id: string) => {
    writeBoxes(boxes.filter(b => b.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const duplicate = (b: CoverageBox) => {
    const offset = dim ? Math.max(8, dim.w / 60) : 12;
    const copy: CoverageBox = {
      ...b,
      id: crypto.randomUUID(),
      rect: { ...b.rect, x: b.rect.x + offset, y: b.rect.y + offset },
    };
    writeBoxes([...boxes, copy]);
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
    if (!dim) return;
    const p = photoPoint(e);
    if (!p) return;
    if (tool === 'calibrate-plane') {
      // Four clicks around a rectangle you know the real size of.
      const next = [...cornerDraft, p].slice(0, 4);
      setCornerDraft(next);
      return;
    }
    if (tool === 'calibrate-line') {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      setDrag({ kind: 'calib-line', x1: p.x, y1: p.y, x2: p.x, y2: p.y });
      return;
    }
    if (tool !== 'box') return;
    setSelectedId(null);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({ kind: 'draw', x1: p.x, y1: p.y, x2: p.x, y2: p.y });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = photoPoint(e);
    if (!p) return;
    if (drag.kind === 'draw' || drag.kind === 'calib-line') {
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
    if (drag?.kind === 'calib-line') {
      if (Math.hypot(drag.x2 - drag.x1, drag.y2 - drag.y1) >= MIN_BOX_PX) {
        setLineDraft({ x1: drag.x1, y1: drag.y1, x2: drag.x2, y2: drag.y2 });
      }
    } else if (drag?.kind === 'draw') {
      const x = Math.min(drag.x1, drag.x2), y = Math.min(drag.y1, drag.y2);
      const w = Math.abs(drag.x2 - drag.x1), h = Math.abs(drag.y2 - drag.y1);
      // A click that never became a drag is a miss, not an invisible box.
      if (w >= MIN_BOX_PX && h >= MIN_BOX_PX) {
        const box: CoverageBox = {
          id: crypto.randomUUID(),
          label: `Area ${boxes.length + 1}`,
          color: nextCoverageColor(boxes.length),
          rect: { x, y, w, h },
          qty: 1,
          substrate_id: defaultFilmId || null,
        };
        writeBoxes([...boxes, box]);
        setSelectedId(box.id);
        setTool('select');
      }
    }
    setDrag(null);
  };

  // ----- Committing a calibration -----
  const commitLine = () => {
    const inches = parseFloat(lineInches);
    if (!lineDraft || !Number.isFinite(inches) || inches <= 0) return;
    const nextCal: PhotoCalibration = { ...(cal || {}), line: { ...lineDraft, inches } };
    onChange({ calibration: nextCal, boxes: measureBoxes(boxes, nextCal) });
    setLineDraft(null); setLineInches(''); setTool('select');
  };

  const commitPlane = () => {
    const w = parseFloat(planeW), h = parseFloat(planeH);
    if (cornerDraft.length !== 4 || !(w > 0) || !(h > 0)) return;
    const nextCal: PhotoCalibration = { ...(cal || {}), plane: { corners: cornerDraft, widthIn: w, heightIn: h } };
    onChange({ calibration: nextCal, boxes: measureBoxes(boxes, nextCal) });
    setCornerDraft([]); setPlaneW(''); setPlaneH(''); setTool('select');
  };

  const clearCalibration = (which: 'line' | 'plane') => {
    const nextCal: PhotoCalibration = { ...(cal || {}) };
    delete nextCal[which];
    const usable = nextCal.line || nextCal.plane ? nextCal : null;
    onChange({ calibration: usable, boxes: measureBoxes(boxes, usable) });
  };

  // Delete removes the selected box, Esc backs out of whatever is in progress.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (e.key === 'Escape') {
        setSelectedId(null); setDrag(null); setLineDraft(null); setCornerDraft([]);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault(); remove(selectedId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remove() closes over the current boxes
  }, [selectedId, boxes, cal]);

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
  const smallBtn = (color: string, bg: string) => ({
    padding: '5px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
    cursor: 'pointer', background: bg, border: `1px solid ${color}`, color,
  });

  const previewRect = drag?.kind === 'draw'
    ? { x: Math.min(drag.x1, drag.x2), y: Math.min(drag.y1, drag.y2), w: Math.abs(drag.x2 - drag.x1), h: Math.abs(drag.y2 - drag.y1) }
    : null;
  const liveLine = drag?.kind === 'calib-line' ? drag : lineDraft;

  // Do the two references agree? A big gap means one of them isn't in the
  // plane being measured — usually something in the background.
  const disagreement = selected ? calibrationDisagreementPct(selected.rect, cal) : null;
  const ppi = pxPerInch(cal?.line);

  const totalSqft = boxes.reduce((sum, b) => sum + (b.area_in2 ? sqft(b.area_in2) * Math.max(1, b.qty || 1) : 0), 0);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '250px minmax(0, 1fr)', gap: '12px', alignItems: 'start' }}>
      {/* Tools + scale + box list */}
      <div style={{ background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '12px' }}>
        <div style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '8px' }}>Coverage Proof</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '10px' }}>
          <button onClick={() => { setTool('box'); setLineDraft(null); setCornerDraft([]); }} style={btn(tool === 'box', '#06b6d4')}>Draw Box</button>
          <button onClick={() => { setTool('select'); setDrag(null); setLineDraft(null); setCornerDraft([]); }} style={btn(tool === 'select', '#06b6d4')}>Select / Move</button>
        </div>

        {/* ── Scale ── */}
        <div style={{
          padding: '8px', borderRadius: '8px', marginBottom: '10px',
          background: calibrated ? 'rgba(34,197,94,0.08)' : 'rgba(251,191,36,0.08)',
          border: `1px solid ${calibrated ? 'rgba(34,197,94,0.3)' : 'rgba(251,191,36,0.3)'}`,
        }}>
          <div style={{ fontSize: '10px', fontWeight: 800, color: calibrated ? '#22c55e' : '#fbbf24', marginBottom: '4px' }}>
            {calibrated ? 'Scale set — boxes are measured' : 'No scale yet — boxes are a picture only'}
          </div>
          {cal?.plane && (
            <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '2px' }}>
              ▸ Known rectangle {cal.plane.widthIn}&quot; × {cal.plane.heightIn}&quot; — perspective corrected
              <button onClick={() => clearCalibration('plane')} title="Remove this reference" style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '10px', fontWeight: 700 }}>✕</button>
            </div>
          )}
          {cal?.line && (
            <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '2px' }}>
              ▸ Known length {cal.line.inches}&quot;{ppi ? ` — ${ppi.toFixed(1)} px/in` : ''}{cal.plane ? ' (backup)' : ''}
              <button onClick={() => clearCalibration('line')} title="Remove this reference" style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '10px', fontWeight: 700 }}>✕</button>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginTop: '6px' }}>
            <button
              onClick={() => { setTool('calibrate-line'); setCornerDraft([]); }}
              title="Drag along something on that same face whose real length you know — a door width, a window, a panel"
              style={btn(tool === 'calibrate-line', '#fbbf24')}
            >Known length</button>
            <button
              onClick={() => { setTool('calibrate-plane'); setLineDraft(null); setCornerDraft([]); }}
              title="Click the four corners of something rectangular whose real size you know — a door, a window. Corrects for camera angle, so it's the one to use when the shot isn't square-on"
              style={btn(tool === 'calibrate-plane', '#fbbf24')}
            >Known rectangle</button>
          </div>
          <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '6px', lineHeight: 1.5 }}>
            Measure something <b>on the same face you&apos;re covering</b> — a door or window frame on that wall,
            a panel or the wheelbase on that side of the vehicle. Anything at a different depth (a wall at an
            angle, the building behind a van, a car parked in front) is a different distance from the camera and
            throws every box off.
          </div>
        </div>

        {/* Calibration in progress */}
        {tool === 'calibrate-line' && !lineDraft && (
          <div style={{ padding: '8px', borderRadius: '8px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)', fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '10px', lineHeight: 1.5 }}>
            Drag a line along something you know the length of — the front door, a window, a panel — then type that length.
          </div>
        )}
        {lineDraft && (
          <div style={{ padding: '8px', borderRadius: '8px', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.35)', marginBottom: '10px' }}>
            <div style={labelStyle}>How long is that line? (inches)</div>
            <input
              type="number" autoFocus value={lineInches}
              onChange={e => setLineInches(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') commitLine(); }}
              placeholder="e.g. 36"
              style={{ ...inputStyle, marginBottom: '6px' }}
            />
            <div style={{ display: 'flex', gap: '6px' }}>
              <button onClick={commitLine} disabled={!(parseFloat(lineInches) > 0)} style={{ ...smallBtn('#22c55e', 'rgba(34,197,94,0.1)'), opacity: parseFloat(lineInches) > 0 ? 1 : 0.5 }}>Set scale</button>
              <button onClick={() => { setLineDraft(null); setLineInches(''); }} style={smallBtn('#ef4444', 'transparent')}>Cancel</button>
            </div>
          </div>
        )}
        {tool === 'calibrate-plane' && (
          <div style={{ padding: '8px', borderRadius: '8px', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.35)', marginBottom: '10px' }}>
            <div style={{ fontSize: '10px', fontWeight: 700, color: '#fbbf24', marginBottom: '4px' }}>
              {cornerDraft.length < 4
                ? `Click corner ${cornerDraft.length + 1} of 4`
                : 'Four corners placed — now its real size'}
            </div>
            <div style={{ fontSize: '9px', color: 'var(--text-secondary)', marginBottom: '6px', lineHeight: 1.5 }}>
              A door or window frame does nicely. Go around it in order: top-left, top-right, bottom-right,
              bottom-left <b>as the rectangle itself sits</b>, not as the photo does. On a square-on shot the
              known-length tool is quicker and just as accurate.
            </div>
            {cornerDraft.length === 4 && (
              <>
                <div style={labelStyle}>Its real width (in)</div>
                <input type="number" value={planeW} onChange={e => setPlaneW(e.target.value)} style={{ ...inputStyle, marginBottom: '4px' }} />
                <div style={labelStyle}>Its real height (in)</div>
                <input type="number" value={planeH} onChange={e => setPlaneH(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') commitPlane(); }} style={{ ...inputStyle, marginBottom: '6px' }} />
              </>
            )}
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {cornerDraft.length === 4 && (
                <button onClick={commitPlane} disabled={!(parseFloat(planeW) > 0 && parseFloat(planeH) > 0)} style={{ ...smallBtn('#22c55e', 'rgba(34,197,94,0.1)'), opacity: parseFloat(planeW) > 0 && parseFloat(planeH) > 0 ? 1 : 0.5 }}>Set scale</button>
              )}
              {cornerDraft.length > 0 && (
                <button onClick={() => setCornerDraft(cornerDraft.slice(0, -1))} style={smallBtn('#f59e0b', 'transparent')}>Undo point</button>
              )}
              <button onClick={() => { setCornerDraft([]); setTool('select'); }} style={smallBtn('#ef4444', 'transparent')}>Cancel</button>
            </div>
          </div>
        )}

        {tool === 'box' && !lineDraft && (
          <div style={{ padding: '8px', borderRadius: '8px', background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.25)', fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '10px', lineHeight: 1.5 }}>
            Drag a box over each area being covered.{calibrated ? ' Its size is measured off the photo as you draw.' : ' Set a scale above to get sizes and pricing.'}
          </div>
        )}

        <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>
          Boxes ({boxes.length}){totalSqft > 0 ? ` · ${totalSqft.toFixed(1)} ft²` : ''}
        </div>
        {boxes.length === 0 && <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '8px' }}>Nothing drawn yet.</div>}
        {boxes.map(b => (
          <div key={b.id} onClick={() => { setSelectedId(b.id); setTool('select'); }} style={{
            display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 6px', marginBottom: '3px', borderRadius: '6px', cursor: 'pointer',
            background: b.id === selectedId ? 'rgba(245,158,11,0.12)' : 'var(--subtle-bg)',
            border: `1px solid ${b.id === selectedId ? 'rgba(245,158,11,0.4)' : 'transparent'}`,
          }}>
            <span style={{ width: '10px', height: '10px', borderRadius: '3px', background: b.color, flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {b.label || 'Untitled'}
              {b.area_in2 ? <span style={{ fontWeight: 600, color: 'var(--text-muted)' }}> · {sqft(b.area_in2).toFixed(1)} ft²</span> : null}
            </span>
            <button onClick={e => { e.stopPropagation(); remove(b.id); }} title="Delete" style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>✕</button>
          </div>
        ))}

        {selected && (
          <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: `1px solid ${theme.border}` }}>
            <div style={labelStyle}>Label</div>
            <input
              value={selected.label}
              onChange={e => update(selected.id, { label: e.target.value })}
              placeholder="Front window, Driver side, …"
              style={{ ...inputStyle, marginBottom: '8px' }}
            />
            <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
              <div style={{ flex: 1 }}>
                <div style={labelStyle}>Width (in)</div>
                <input
                  type="number"
                  value={selected.width_in != null ? Number(selected.width_in.toFixed(2)) : ''}
                  onChange={e => typeDimension(selected.id, 'width_in', e.target.value)}
                  placeholder={calibrated ? '' : 'set a scale'}
                  style={inputStyle}
                />
              </div>
              <div style={{ flex: 1 }}>
                <div style={labelStyle}>Height (in)</div>
                <input
                  type="number"
                  value={selected.height_in != null ? Number(selected.height_in.toFixed(2)) : ''}
                  onChange={e => typeDimension(selected.id, 'height_in', e.target.value)}
                  placeholder={calibrated ? '' : 'set a scale'}
                  style={inputStyle}
                />
              </div>
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '8px', lineHeight: 1.5 }}>
              {selected.manual ? (
                <>
                  Typed by hand.{' '}
                  {calibrated && (
                    <button onClick={() => revertToMeasured(selected.id)} style={{ background: 'none', border: 'none', padding: 0, color: '#06b6d4', fontWeight: 700, fontSize: '10px', cursor: 'pointer' }}>
                      Use the photo&apos;s measurement instead
                    </button>
                  )}
                </>
              ) : selected.measured_by === 'plane' ? 'Measured off the photo, perspective corrected.'
                : selected.measured_by === 'line' ? 'Measured off the photo with the known length.'
                : 'No scale set — type the size, or calibrate the photo above.'}
              {selected.area_in2 ? ` · ${sqft(selected.area_in2).toFixed(2)} ft² each` : ''}
            </div>
            {disagreement != null && disagreement > DISAGREEMENT_WARN_PCT && (
              <div style={{ fontSize: '10px', fontWeight: 700, color: '#fbbf24', marginBottom: '8px', lineHeight: 1.5 }}>
                ⚠ Your two references disagree by {disagreement.toFixed(0)}% on this box. They&apos;re probably not
                the same distance from the camera — drop whichever one isn&apos;t on the face you&apos;re covering.
              </div>
            )}
            <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
              <div style={{ width: '70px' }}>
                <div style={labelStyle}>Qty</div>
                <input
                  type="number" min={1}
                  value={selected.qty ?? 1}
                  onChange={e => update(selected.id, { qty: Math.max(1, Math.round(parseFloat(e.target.value) || 1)) })}
                  style={inputStyle}
                />
              </div>
              <div style={{ flex: 1 }}>
                <div style={labelStyle}>Film</div>
                <select
                  value={selected.substrate_id || ''}
                  onChange={e => { const v = e.target.value || null; update(selected.id, { substrate_id: v }); onPickFilm?.(v); }}
                  style={inputStyle}
                >
                  <option value="">— none —</option>
                  {films.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
                </select>
              </div>
            </div>
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
              <button onClick={() => duplicate(selected)} style={smallBtn('#06b6d4', 'rgba(6,182,212,0.08)')}>⧉ Duplicate</button>
              <button onClick={() => remove(selected.id)} style={smallBtn('#ef4444', 'transparent')}>Delete</button>
            </div>
          </div>
        )}
      </div>

      {/* Photo canvas */}
      <div style={{ position: 'relative', background: '#000', border: `1px solid ${theme.border}`, borderRadius: '12px', overflow: 'hidden' }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- photo dimensions are unknown; next/image needs fixed sizes */}
        <img
          src={src}
          alt="Job photo"
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
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: tool === 'select' ? 'default' : 'crosshair', touchAction: 'none' }}
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
            {/* The calibration line: the one being dragged, or the stored one
                while its tool is open, so the reference stays visible. */}
            {(liveLine || (tool === 'calibrate-line' && cal?.line)) && (() => {
              const l = liveLine || cal!.line!;
              const r = dim.w / 120;
              return (
                <g>
                  <line x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="#fbbf24" strokeWidth={3} vectorEffect="non-scaling-stroke" />
                  <circle cx={l.x1} cy={l.y1} r={r} fill="#fbbf24" />
                  <circle cx={l.x2} cy={l.y2} r={r} fill="#fbbf24" />
                </g>
              );
            })()}
            {/* Corners being placed, and the stored rectangle while its tool
                is open. */}
            {(cornerDraft.length > 0 || (tool === 'calibrate-plane' && cal?.plane)) && (() => {
              const pts = cornerDraft.length > 0 ? cornerDraft : cal!.plane!.corners;
              const r = dim.w / 120;
              return (
                <g>
                  <polygon
                    points={pts.map(p => `${p.x},${p.y}`).join(' ')}
                    fill="rgba(251,191,36,0.18)" stroke="#fbbf24" strokeWidth={2}
                    strokeDasharray={pts.length < 4 ? '6 4' : undefined} vectorEffect="non-scaling-stroke"
                  />
                  {pts.map((p, i) => (
                    <g key={i}>
                      <circle cx={p.x} cy={p.y} r={r} fill="#fbbf24" />
                      <text x={p.x + r * 1.4} y={p.y} fill="#fbbf24" fontSize={dim.w / 55} fontWeight={700} dominantBaseline="middle">{i + 1}</text>
                    </g>
                  ))}
                </g>
              );
            })()}
          </svg>
        )}
      </div>
    </div>
  );
}
