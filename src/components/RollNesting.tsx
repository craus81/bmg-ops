'use client';

import { useMemo, useState } from 'react';
import { theme } from '@/lib/theme';
import {
  NestPiece,
  PlacementMap,
  RollConfig,
  computeUsage,
  findLayoutIssues,
  fmtFtIn,
  packPieces,
  placedRect,
  placedSize,
} from '@/lib/roll-nesting';

// The nesting canvas for wrap quotes: every drawn shape (× qty × sets)
// becomes a print piece laid out on a roll of its film. The roll renders
// horizontally — x runs along the roll, the 58.5" width is vertical.
// Pieces drag with edge snapping, rotate in 90° steps, and "Auto-Nest"
// repacks everything from scratch.

export interface RollFilmInfo {
  key: string; // film id, '' = no film assigned
  label: string;
  color: string;
  ratePerSqft: number; // combined film+laminate $/ft² (0 = unpriced)
}

interface Props {
  pieces: NestPiece[];
  films: RollFilmInfo[];
  config: RollConfig;
  onConfigChange: (c: RollConfig) => void;
  placements: PlacementMap;
  onPlacementsChange: (p: PlacementMap) => void;
  sets: number;
  onSetsChange: (n: number) => void;
  useRollPricing: boolean;
  onUseRollPricingChange: (v: boolean) => void;
}

const fmt1 = (n: number) => (Math.round(n * 10) / 10).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmt2 = (n: number) => (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numv = (v: string) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

interface DragState {
  key: string;
  originX: number; // placement inches at drag start
  originY: number;
  clientX: number; // pointer px at drag start
  clientY: number;
}

export function RollNesting(props: Props) {
  const { pieces, films, config, onConfigChange, placements, onPlacementsChange, sets, onSetsChange, useRollPricing, onUseRollPricingChange } = props;

  const [zoom, setZoom] = useState(6); // px per inch
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  // Config fields edit as strings so "58." can be typed; committed on blur.
  const [cfgDraft, setCfgDraft] = useState<{ [K in keyof RollConfig]?: string }>({});

  const usage = useMemo(() => computeUsage(pieces, placements, config), [pieces, placements, config]);
  const issues = useMemo(() => findLayoutIssues(pieces, placements, config), [pieces, placements, config]);
  const pieceByKey = useMemo(() => new Map(pieces.map(p => [p.key, p])), [pieces]);
  const filmByKey = useMemo(() => new Map(films.map(f => [f.key, f])), [films]);

  const margin = config.edgeMarginIn;
  const usableW = config.widthIn - 2 * margin;

  // Film groups in the order the films prop lists them (films with pieces only).
  const filmGroups = useMemo(() => {
    const present = new Set(pieces.map(p => p.filmKey));
    const known = films.filter(f => present.has(f.key));
    const unknown = [...present].filter(k => !filmByKey.has(k)).map(k => ({ key: k, label: 'Unknown film', color: '#94a3b8', ratePerSqft: 0 }));
    return [...known, ...unknown];
  }, [pieces, films, filmByKey]);

  const commitConfig = (key: keyof RollConfig, raw: string, min: number, scale = 1) => {
    const v = Math.max(min, numv(raw) * scale);
    setCfgDraft(d => ({ ...d, [key]: undefined }));
    if (Math.abs(v - config[key]) > 1e-9) onConfigChange({ ...config, [key]: v });
  };

  const autoNest = () => {
    const { placements: packed } = packPieces(pieces, config);
    onPlacementsChange(packed);
    setSelectedKey(null);
  };

  const rotatePiece = (key: string) => {
    const pl = placements[key];
    const piece = pieceByKey.get(key);
    if (!pl || !piece) return;
    const rot = pl.rot === 90 ? 0 : 90;
    const { w, h } = placedSize(piece, rot);
    onPlacementsChange({
      ...placements,
      [key]: {
        ...pl,
        rot,
        x: Math.min(Math.max(pl.x, margin), Math.max(margin, config.lengthIn - margin - w)),
        y: Math.min(Math.max(pl.y, margin), Math.max(margin, config.widthIn - margin - h)),
      },
    });
  };

  const beginDrag = (e: React.PointerEvent, key: string) => {
    const pl = placements[key];
    if (!pl) return;
    e.stopPropagation();
    setSelectedKey(key);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({ key, originX: pl.x, originY: pl.y, clientX: e.clientX, clientY: e.clientY });
  };

  const moveDrag = (e: React.PointerEvent) => {
    if (!drag) return;
    const piece = pieceByKey.get(drag.key);
    const pl = placements[drag.key];
    if (!piece || !pl) return;
    const { w: pw, h: ph } = placedSize(piece, pl.rot);
    let x = drag.originX + (e.clientX - drag.clientX) / zoom;
    let y = drag.originY + (e.clientY - drag.clientY) / zoom;
    x = Math.min(Math.max(x, margin), Math.max(margin, config.lengthIn - margin - pw));
    y = Math.min(Math.max(y, margin), Math.max(margin, config.widthIn - margin - ph));

    // Snap to the roll edges and to neighbors: flush edges, or exactly one
    // gap away (the "pieces click together" feel). Threshold is ~8 screen px.
    const tol = 8 / zoom;
    const xCands = [margin, config.lengthIn - margin - pw];
    const yCands = [margin, config.widthIn - margin - ph];
    for (const other of pieces) {
      if (other.key === drag.key || other.filmKey !== piece.filmKey) continue;
      const opl = placements[other.key];
      if (!opl || opl.roll !== pl.roll) continue;
      const r = placedRect(other, opl);
      xCands.push(r.x, r.x + r.w - pw, r.x + r.w + config.spacingIn, r.x - config.spacingIn - pw);
      yCands.push(r.y, r.y + r.h - ph, r.y + r.h + config.spacingIn, r.y - config.spacingIn - ph);
    }
    let bestX: number | null = null;
    for (const c of xCands) if (Math.abs(c - x) < tol && (bestX === null || Math.abs(c - x) < Math.abs(bestX - x))) bestX = c;
    let bestY: number | null = null;
    for (const c of yCands) if (Math.abs(c - y) < tol && (bestY === null || Math.abs(c - y) < Math.abs(bestY - y))) bestY = c;
    if (bestX !== null) x = bestX;
    if (bestY !== null) y = bestY;

    onPlacementsChange({ ...placements, [drag.key]: { ...pl, x, y } });
  };

  const endDrag = () => setDrag(null);

  // Measurements with qty > 1 get a #n suffix so identical pieces are
  // tellable apart; precomputed because labels render on every drag frame.
  const multiCopy = useMemo(() => {
    const s = new Set<string>();
    for (const p of pieces) if (p.copy > 0) s.add(`${p.filmKey}|${p.name}`);
    return s;
  }, [pieces]);

  const pieceLabel = (p: NestPiece) =>
    `${p.name}${multiCopy.has(`${p.filmKey}|${p.name}`) ? ` #${p.copy + 1}` : ''}${sets > 1 ? ` · S${p.set + 1}` : ''}`;

  const selPiece = selectedKey ? pieceByKey.get(selectedKey) : null;
  const selPl = selectedKey ? placements[selectedKey] : null;

  const inputStyle: React.CSSProperties = { width: '72px', padding: '6px 8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px' };
  const labelStyle: React.CSSProperties = { fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' };

  const totalMaterial = usage.films.reduce((sum, f) => sum + f.rollSqft * (filmByKey.get(f.filmKey)?.ratePerSqft || 0), 0);

  if (pieces.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: '13px', fontWeight: 600 }}>
        Nothing to nest yet — draw the graphics on the Estimator tab first. Every shape (× its quantity × sets) becomes a piece on the roll.
      </div>
    );
  }

  return (
    <div>
      {/* Controls */}
      <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-end', flexWrap: 'wrap', background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '12px 14px', marginBottom: '12px' }}>
        <div>
          <div style={labelStyle}>Roll Width (in)</div>
          <input type="number" step="0.5" value={cfgDraft.widthIn ?? String(config.widthIn)}
            onChange={e => setCfgDraft(d => ({ ...d, widthIn: e.target.value }))}
            onBlur={e => commitConfig('widthIn', e.target.value, 1)} style={inputStyle} />
        </div>
        <div>
          <div style={labelStyle}>Roll Length (ft)</div>
          <input type="number" step="1" value={cfgDraft.lengthIn ?? String(config.lengthIn / 12)}
            onChange={e => setCfgDraft(d => ({ ...d, lengthIn: e.target.value }))}
            onBlur={e => commitConfig('lengthIn', e.target.value, 12, 12)} style={inputStyle} />
        </div>
        <div>
          <div style={labelStyle}>Piece Gap (in)</div>
          <input type="number" step="0.25" value={cfgDraft.spacingIn ?? String(config.spacingIn)}
            onChange={e => setCfgDraft(d => ({ ...d, spacingIn: e.target.value }))}
            onBlur={e => commitConfig('spacingIn', e.target.value, 0)} style={inputStyle} />
        </div>
        <div>
          <div style={labelStyle}>Edge Margin (in)</div>
          <input type="number" step="0.25" value={cfgDraft.edgeMarginIn ?? String(config.edgeMarginIn)}
            onChange={e => setCfgDraft(d => ({ ...d, edgeMarginIn: e.target.value }))}
            onBlur={e => commitConfig('edgeMarginIn', e.target.value, 0)} style={inputStyle} />
        </div>
        <div title="How many complete sets of the drawn graphics to nest — this is the quote's kit quantity">
          <div style={labelStyle}>Sets (kits)</div>
          <input type="number" min="1" step="1" value={sets}
            onChange={e => onSetsChange(Math.max(1, Math.round(numv(e.target.value) || 1)))} style={inputStyle} />
        </div>
        <div>
          <div style={labelStyle}>Zoom</div>
          <input type="range" min="2" max="14" step="1" value={zoom} onChange={e => setZoom(numv(e.target.value) || 6)} style={{ width: '110px' }} />
        </div>
        <button onClick={autoNest} style={{ padding: '8px 16px', borderRadius: '8px', fontSize: '12px', fontWeight: 800, border: 'none', background: '#06b6d4', color: '#fff', cursor: 'pointer' }}>
          ⚡ Auto-Nest
        </button>
        {selPiece && selPl && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', borderRadius: '8px', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.35)' }}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: '#f59e0b' }}>
              {pieceLabel(selPiece)} — {fmt1(placedSize(selPiece, selPl.rot).w)}" × {fmt1(placedSize(selPiece, selPl.rot).h)}"
            </span>
            <button onClick={() => rotatePiece(selPiece.key)} style={{ padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.4)', color: '#f59e0b' }}>
              ⟳ Rotate 90°
            </button>
          </div>
        )}
        <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12px', fontWeight: 800, color: useRollPricing ? '#22c55e' : 'var(--text-secondary)', cursor: 'pointer' }}
          title="On: quote materials = roll width × used length per film (what you actually cut). Off: materials price by shape area as before.">
          <input type="checkbox" checked={useRollPricing} onChange={e => onUseRollPricingChange(e.target.checked)} />
          Price materials from roll usage
          <span style={{ fontWeight: 700, color: 'var(--text-muted)' }}>
            {fmt1(usage.totalRollSqft)} ft²{totalMaterial > 0 ? ` → $${fmt2(totalMaterial)}` : ''}
          </span>
        </label>
      </div>

      {/* Layout problems */}
      {(issues.overlapping.size > 0 || issues.outOfBounds.size > 0) && (
        <div style={{ padding: '8px 12px', borderRadius: '8px', marginBottom: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', fontSize: '11px', fontWeight: 700, color: '#ef4444' }}>
          {issues.overlapping.size > 0 ? `${issues.overlapping.size} piece${issues.overlapping.size !== 1 ? 's' : ''} overlapping — drag them apart or Auto-Nest. ` : ''}
          {issues.outOfBounds.size > 0 ? `${issues.outOfBounds.size} piece${issues.outOfBounds.size !== 1 ? 's' : ''} off the roll.` : ''}
        </div>
      )}
      {usage.unplaced.length > 0 && (
        <div style={{ padding: '8px 12px', borderRadius: '8px', marginBottom: '10px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', fontSize: '11px', fontWeight: 700, color: '#fbbf24' }}>
          Couldn&apos;t place: {usage.unplaced.map(p => `${pieceLabel(p)} (${fmt1(p.w)}" × ${fmt1(p.h)}")`).join(', ')} — {
            usage.unplaced.some(p => Math.min(p.w, p.h) > usableW)
              ? 'wider than the roll in both orientations; split the panel or it will be billed by its area instead.'
              : 'no roll space left; these bill by area instead.'}
        </div>
      )}

      {/* One section per film, one canvas per roll */}
      {filmGroups.map(film => {
        const fUsage = usage.films.find(f => f.filmKey === film.key);
        const filmPieces = pieces.filter(p => p.filmKey === film.key);
        const rollIndexes = [...new Set(filmPieces.map(p => placements[p.key]?.roll).filter((r): r is number => r != null))].sort((a, b) => a - b);
        const waste = fUsage && fUsage.rollSqft > 0 ? Math.max(0, (1 - fUsage.graphicSqft / fUsage.rollSqft) * 100) : 0;
        const material = (fUsage?.rollSqft || 0) * film.ratePerSqft;
        return (
          <div key={film.key || 'none'} style={{ marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '6px' }}>
              <span style={{ width: '10px', height: '10px', borderRadius: '3px', background: film.color, flexShrink: 0 }} />
              <span style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)' }}>{film.key ? film.label : 'No film assigned'}</span>
              {fUsage && (
                <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)' }}>
                  {fUsage.rolls.length > 1 ? `${fUsage.rolls.length} rolls · ` : ''}
                  {fmtFtIn(fUsage.rolls.reduce((s, r) => s + r.usedLengthIn, 0))} used · {fmt1(fUsage.rollSqft)} ft² roll · {fmt1(fUsage.graphicSqft)} ft² graphics · {waste.toFixed(0)}% waste
                  {film.ratePerSqft > 0 ? ` · $${fmt2(material)} @ $${fmt2(film.ratePerSqft)}/ft²` : ''}
                </span>
              )}
            </div>
            {rollIndexes.map(rollIdx => {
              const rollPieces = filmPieces.filter(p => placements[p.key]?.roll === rollIdx);
              const usedLen = rollPieces.reduce((max, p) => {
                const r = placedRect(p, placements[p.key]);
                return Math.max(max, r.x + r.w + margin);
              }, 0);
              const displayLen = Math.min(config.lengthIn, Math.max(120, usedLen + 48));
              return (
                <div key={rollIdx} style={{ marginBottom: '8px' }}>
                  {rollIndexes.length > 1 && (
                    <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '3px' }}>
                      Roll {rollIdx + 1} — {fmtFtIn(usedLen)} used
                    </div>
                  )}
                  <div style={{ overflowX: 'auto', border: `1px solid ${theme.border}`, borderRadius: '10px', background: '#fff' }}>
                    <svg
                      width={displayLen * zoom}
                      height={config.widthIn * zoom + 16}
                      onPointerMove={moveDrag}
                      onPointerUp={endDrag}
                      onPointerDown={() => setSelectedKey(null)}
                      style={{ display: 'block', touchAction: 'none' }}
                    >
                      {/* Foot ruler + grid */}
                      {Array.from({ length: Math.floor(displayLen / 12) + 1 }, (_, i) => (
                        <g key={i}>
                          <line x1={i * 12 * zoom} y1={16} x2={i * 12 * zoom} y2={config.widthIn * zoom + 16} stroke="#e5e7eb" strokeWidth={i % 5 === 0 ? 1.5 : 0.75} />
                          {(zoom >= 4 || i % 5 === 0) && (
                            <text x={i * 12 * zoom + 3} y={11} fontSize={9} fill="#9ca3af" fontWeight={700}>{i}&apos;</text>
                          )}
                        </g>
                      ))}
                      {/* Edge margins */}
                      {margin > 0 && (
                        <>
                          <line x1={0} y1={margin * zoom + 16} x2={displayLen * zoom} y2={margin * zoom + 16} stroke="#f3d9a4" strokeDasharray="4 4" strokeWidth={1} />
                          <line x1={0} y1={(config.widthIn - margin) * zoom + 16} x2={displayLen * zoom} y2={(config.widthIn - margin) * zoom + 16} stroke="#f3d9a4" strokeDasharray="4 4" strokeWidth={1} />
                        </>
                      )}
                      {/* Used-length cut line */}
                      {usedLen > 0 && (
                        <g>
                          <line x1={usedLen * zoom} y1={16} x2={usedLen * zoom} y2={config.widthIn * zoom + 16} stroke="#ef4444" strokeDasharray="6 4" strokeWidth={1.5} />
                          <text x={usedLen * zoom + 4} y={30} fontSize={10} fill="#ef4444" fontWeight={800}>
                            {fmtFtIn(usedLen)} · {fmt1((usedLen * config.widthIn) / 144)} ft²
                          </text>
                        </g>
                      )}
                      {/* Pieces */}
                      {rollPieces.map(p => {
                        const pl = placements[p.key];
                        const r = placedRect(p, pl);
                        const sel = p.key === selectedKey;
                        const bad = issues.overlapping.has(p.key) || issues.outOfBounds.has(p.key);
                        const stroke = bad ? '#ef4444' : sel ? '#f59e0b' : film.color;
                        const showName = r.w * zoom > 46 && r.h * zoom > 14;
                        const showDims = showName && r.h * zoom > 30;
                        return (
                          <g key={p.key}
                            onPointerDown={e => beginDrag(e, p.key)}
                            onDoubleClick={() => rotatePiece(p.key)}
                            style={{ cursor: 'move' }}
                          >
                            <rect x={r.x * zoom} y={r.y * zoom + 16} width={r.w * zoom} height={r.h * zoom}
                              fill={bad ? 'rgba(239,68,68,0.25)' : film.color + (sel ? '59' : '33')}
                              stroke={stroke} strokeWidth={sel || bad ? 2 : 1.25} rx={2} />
                            {showName && (
                              <text x={r.x * zoom + 4} y={r.y * zoom + 16 + 12} fontSize={10} fontWeight={700} fill="#374151" style={{ pointerEvents: 'none', userSelect: 'none' }}>
                                {pieceLabel(p)}
                              </text>
                            )}
                            {showDims && (
                              <text x={r.x * zoom + 4} y={r.y * zoom + 16 + 24} fontSize={9} fill="#6b7280" style={{ pointerEvents: 'none', userSelect: 'none' }}>
                                {fmt1(r.w)}&quot; × {fmt1(r.h)}&quot;
                              </text>
                            )}
                          </g>
                        );
                      })}
                    </svg>
                  </div>
                </div>
              );
            })}
            {rollIndexes.length === 0 && (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>No pieces placed for this film yet — hit Auto-Nest.</div>
            )}
          </div>
        );
      })}

      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px', lineHeight: 1.6 }}>
        Drag pieces to fine-tune the layout (they snap to edges, one gap apart) · double-click or use ⟳ to rotate ·
        the red dashed line is where the roll gets cut — that length × the roll width is the material you&apos;re paying for.
        Pieces include each film&apos;s bleed. Changing shapes on the Estimator adds/removes pieces here without disturbing your layout.
      </div>
    </div>
  );
}
