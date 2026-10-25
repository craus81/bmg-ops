'use client';

import { useEffect, useRef, useState } from 'react';
import { theme } from '@/lib/theme';
import { closeOnEscape } from '@/lib/modal-escape';
import { useFocusTrap } from '@/lib/use-focus-trap';
import VinScanner from '@/components/VinScanner';
import { decodeVinDetails, isValidVIN, windowStickerUrl, type VinDetails } from '@/lib/vin-decoder';
import { resolvePlatform } from '@/lib/vin-platform';
import { apiFetch } from '@/lib/api-client';
import { mergeFactory, type FactoryData } from '@/lib/vin-factory-data';

/**
 * Stand-alone VIN lookup (header "VIN" button). Type, paste or scan a VIN and
 * see what it decodes to — year/make/model, cab, bed length, wheelbase, drive,
 * engine, GVWR. Saves nothing and touches no record: it's for answering "what
 * is this truck?" without opening a check-in or an estimate.
 */
export default function VinLookupModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [vin, setVin] = useState('');
  const [scanning, setScanning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [details, setDetails] = useState<VinDetails | null>(null);
  const [lookedUp, setLookedUp] = useState('');
  const [copied, setCopied] = useState('');
  // Paid factory data (CarsXE), fetched after the free NHTSA decode.
  const [factory, setFactory] = useState<{ loading: boolean; data: FactoryData | null; message: string }>({ loading: false, data: null, message: '' });
  const inputRef = useRef<HTMLInputElement>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(open);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
    else setScanning(false);
  }, [open]);

  if (!open) return null;

  const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 17);

  const lookUp = async (raw: string) => {
    const v = clean(raw);
    setVin(v);
    setScanning(false);
    setError('');
    setDetails(null);
    setFactory({ loading: false, data: null, message: '' });
    if (!isValidVIN(v)) {
      setError(v.length !== 17
        ? `A VIN is 17 characters — this one has ${v.length}.`
        : 'VINs never use the letters I, O or Q. Check for a 1 or 0 misread.');
      return;
    }
    setLoading(true);
    let cab = '';
    try {
      const d = await decodeVinDetails(v);
      cab = d.groups[1]?.rows.find(r => r.label === 'Cab')?.value || '';
      if (!d.title) setDetails(d);
      else {
        // Transit roof height and Sprinter wheelbase live in the VIN body
        // code, not in NHTSA's data — fill them from our own rules.
        const model = d.groups[0].rows.find(r => r.label === 'Model')?.value || '';
        const year = d.groups[0].rows.find(r => r.label === 'Year')?.value || '';
        const plat = resolvePlatform({ make: d.make, model, year }, v);
        const body = d.groups[1].rows;
        const wb = body.find(r => r.label === 'Wheelbase')!;
        if (!wb.value && plat.wheelbase) wb.value = `${plat.wheelbase}"`;
        if (plat.platformKey === 'transit' || plat.platformKey === 'sprinter') {
          body.splice(body.indexOf(wb) + 1, 0, {
            label: 'Roof',
            value: plat.roof ? plat.roof[0].toUpperCase() + plat.roof.slice(1) : '',
          });
        }
        setDetails(d);
      }
      setLookedUp(v);
    } catch {
      setLookedUp(v);
    } finally {
      setLoading(false);
    }
    void loadFactory(v, cab);
  };

  const loadFactory = async (v: string, cab: string) => {
    setFactory({ loading: true, data: null, message: '' });
    try {
      const res = await apiFetch(`/api/vin-lookup?vin=${v}&cab=${encodeURIComponent(cab)}`);
      const j = await res.json();
      if (j.configured === false) { setFactory({ loading: false, data: null, message: '' }); return; }
      setFactory({ loading: false, data: j.found ? j.data : null, message: j.found ? '' : (j.message || j.error || '') });
    } catch {
      setFactory({ loading: false, data: null, message: "Couldn't reach the factory data service" });
    }
  };

  const shown = mergeFactory(details, factory.data);
  const nothing = !!lookedUp && !loading && !factory.loading && !shown?.title;

  const copy = async (what: 'vin' | 'all') => {
    if (!shown) return;
    const text = what === 'vin'
      ? lookedUp
      : [shown.title, `VIN ${lookedUp}`, ...shown.groups.flatMap(g => g.rows.filter(r => r.value).map(r => `${r.label}: ${r.value}`))].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(''), 1500);
    } catch {}
  };

  const reset = () => {
    setVin(''); setDetails(null); setError(''); setLookedUp('');
    setFactory({ loading: false, data: null, message: '' });
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const sticker = shown?.make ? windowStickerUrl(shown.make, lookedUp) : null;
  const body = shown?.groups.find(g => g.heading === 'Body')?.rows || [];
  const missingBed = !factory.loading && body.some(r => r.label === 'Bed length' && !r.value)
    && /pickup/i.test(body.find(r => r.label === 'Body')?.value || '');

  const btn = (primary = false): React.CSSProperties => ({
    padding: '9px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
    border: primary ? 'none' : `1px solid ${theme.border}`,
    background: primary ? theme.accent : 'transparent',
    color: primary ? '#fff' : theme.textPrimary,
  });

  return (
    <div
      ref={closeOnEscape(onClose)}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: 'calc(env(safe-area-inset-top, 0px) + 24px) 12px 24px',
      }}
    >
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label="VIN lookup"
        style={{
          width: '100%', maxWidth: '520px', maxHeight: 'calc(90vh / var(--ts, 1))', overflowY: 'auto',
          background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px',
          boxShadow: theme.shadowMd, color: theme.textPrimary,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: `1px solid ${theme.border}` }}>
          <div style={{ fontSize: '16px', fontWeight: 800 }}>VIN Lookup</div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', fontSize: '20px', color: theme.textSecondary, cursor: 'pointer', lineHeight: 1 }}>✕</button>
        </div>

        <div style={{ padding: '16px' }}>
          <form onSubmit={e => { e.preventDefault(); void lookUp(vin); }} style={{ display: 'flex', gap: '8px' }}>
            <input
              ref={inputRef}
              value={vin}
              onChange={e => setVin(clean(e.target.value))}
              onPaste={e => { const t = e.clipboardData.getData('text'); if (clean(t).length === 17) { e.preventDefault(); void lookUp(t); } }}
              placeholder="Type or paste a VIN"
              autoCapitalize="characters" autoCorrect="off" spellCheck={false}
              aria-label="VIN"
              style={{
                flex: 1, minWidth: 0, padding: '10px 12px', borderRadius: '8px', fontSize: '15px',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', letterSpacing: '0.5px',
                background: theme.inputBg, border: `1px solid ${theme.border}`, color: theme.textPrimary,
              }}
            />
            <button type="submit" disabled={loading || vin.length === 0} style={{ ...btn(true), opacity: loading || !vin ? 0.6 : 1 }}>
              {loading ? 'Looking…' : 'Look up'}
            </button>
          </form>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px', fontSize: '11px', color: theme.textMuted }}>
            <span>{vin.length}/17</span>
            <button onClick={() => setScanning(s => !s)} style={{ background: 'none', border: 'none', color: theme.orange, fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0 }}>
              {scanning ? 'Stop camera' : '📷 Scan barcode'}
            </button>
          </div>

          {scanning && (
            <div style={{ marginTop: '10px' }}>
              <VinScanner onScan={v => void lookUp(v)} theme={theme} scanLabel="Scan VIN barcode" />
            </div>
          )}

          {error && (
            <div role="alert" style={{ marginTop: '12px', padding: '10px 12px', borderRadius: '8px', fontSize: '13px', background: theme.errorBg, border: `1px solid ${theme.errorBorder}`, color: theme.error }}>
              {error}
            </div>
          )}

          {nothing && (
            <div role="alert" style={{ marginTop: '12px', padding: '10px 12px', borderRadius: '8px', fontSize: '13px', background: theme.errorBg, border: `1px solid ${theme.errorBorder}`, color: theme.error }}>
              Nobody recognises this VIN{factory.message ? ` (${factory.message})` : ''}. Double-check it against the door sticker.
            </div>
          )}

          {shown?.title && (
            <div style={{ marginTop: '14px' }}>
              <div style={{ fontSize: '18px', fontWeight: 800 }}>{shown.title}</div>
              <div style={{ fontSize: '12px', color: theme.textMuted, fontFamily: 'ui-monospace, Menlo, monospace', marginTop: '2px' }}>{lookedUp}</div>

              {factory.loading && (
                <div style={{ marginTop: '10px', fontSize: '12px', color: theme.textMuted }}>Getting factory data (bed, roof, dimensions)…</div>
              )}
              {!factory.loading && factory.message && (
                <div style={{ marginTop: '10px', fontSize: '12px', color: theme.textMuted }}>Factory data: {factory.message}</div>
              )}

              {shown.warning && (
                <div style={{ marginTop: '10px', padding: '8px 10px', borderRadius: '8px', fontSize: '12px', background: theme.warningBg, border: `1px solid ${theme.warningBorder}`, color: theme.warning }}>
                  NHTSA note: {shown.warning}
                </div>
              )}

              {shown.groups.filter(g => g.rows.length).map(g => (
                <div key={g.heading} style={{ marginTop: '14px' }}>
                  <div style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '0.6px', textTransform: 'uppercase', color: theme.textMuted, marginBottom: '4px' }}>{g.heading}</div>
                  {g.rows.map(r => (
                    <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '6px 0', borderBottom: `1px solid ${theme.border}`, fontSize: '14px' }}>
                      <span style={{ color: theme.textSecondary, flexShrink: 0 }}>{r.label}</span>
                      <span style={{ textAlign: 'right', fontWeight: r.value ? 600 : 400, color: r.value ? theme.textPrimary : theme.textMuted, fontStyle: r.value ? 'normal' : 'italic' }}>
                        {r.value || (factory.loading ? '…' : 'Not in the VIN')}
                        {r.value && r.note && (
                          <span style={{ display: 'block', fontSize: '11px', fontWeight: 400, color: theme.textMuted }}>{r.note}</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              ))}

              {(missingBed || sticker) && (
                <div style={{ marginTop: '14px', padding: '10px 12px', borderRadius: '8px', fontSize: '13px', background: theme.bg, border: `1px solid ${theme.border}` }}>
                  {missingBed && <div style={{ marginBottom: sticker ? '6px' : 0 }}>This maker doesn&apos;t put bed length in the VIN. The window sticker lists it.</div>}
                  {sticker
                    ? <a href={sticker} target="_blank" rel="noopener noreferrer" style={{ color: theme.orange, fontWeight: 700 }}>Open the {shown.make} window sticker (not every vehicle has one) ↗</a>
                    : <span style={{ color: theme.textMuted }}>Check the door sticker or the build sheet.</span>}
                </div>
              )}

              {factory.data && factory.data.raw.length > 0 && (
                <details style={{ marginTop: '14px', fontSize: '13px' }}>
                  <summary style={{ cursor: 'pointer', color: theme.textSecondary, fontWeight: 700 }}>All factory fields ({factory.data.raw.length})</summary>
                  {factory.data.raw.map(r => (
                    <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '4px 0', borderBottom: `1px solid ${theme.border}` }}>
                      <span style={{ color: theme.textSecondary, flexShrink: 0 }}>{r.label}</span>
                      <span style={{ textAlign: 'right', wordBreak: 'break-word' }}>{r.value}</span>
                    </div>
                  ))}
                </details>
              )}

              <div style={{ display: 'flex', gap: '8px', marginTop: '16px', flexWrap: 'wrap' }}>
                <button onClick={() => void copy('all')} style={btn()}>{copied === 'all' ? 'Copied ✓' : 'Copy details'}</button>
                <button onClick={() => void copy('vin')} style={btn()}>{copied === 'vin' ? 'Copied ✓' : 'Copy VIN'}</button>
                <button onClick={reset} style={btn()}>New VIN</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
