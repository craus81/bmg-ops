'use client';

import { useState } from 'react';
import VinScanner from '@/components/VinScanner';
import { validateSerial, validateImei, validateIccid } from '@/lib/rfid';

type Field = 'vin' | 'serial' | 'imei' | 'iccid';
type Stage = Field | 'review';

const LABELS: Record<Field, string> = {
  vin: 'VIN', serial: 'Serial # (SN)', imei: 'IMEI', iccid: 'CCID (ICCID)',
};
// `vin` uses VinScanner's built-in VIN validation (no override).
const VALIDATORS: Record<Exclude<Field, 'vin'>, (raw: string) => string | null> = {
  serial: validateSerial, imei: validateImei, iccid: validateIccid,
};

export interface RfidCompletion {
  vin: string;
  serial_number: string;
  imei: string;
  iccid: string;
  unit_number: string | null;
}

interface RfidCaptureProps {
  /** Scan the VIN as the first step (free-scan), or treat it as already known. */
  includeVin: boolean;
  /** The known VIN when includeVin is false (e.g. a CNI job's pre-loaded VIN). */
  lockedVin?: string;
  /** Offer an optional unit-number field on the review screen. */
  showUnit?: boolean;
  /**
   * Persist the captured device. Return null on success, or an error message to
   * show on the review screen (e.g. a duplicate). On success the form resets for
   * the next vehicle.
   */
  onComplete: (data: RfidCompletion) => Promise<string | null>;
  /** Side-effect after a successful log (e.g. refresh a list, close a modal). */
  onLogged?: () => void;
  theme: Record<string, string>;
}

/**
 * Verizon RFID device capture — VIN (optional) then Serial → IMEI → CCID, with a
 * review screen. Shared by the main scan page and the CNI installer flow so the
 * capture behaves identically everywhere.
 */
export default function RfidCapture({ includeVin, lockedVin, showUnit, onComplete, onLogged, theme }: RfidCaptureProps) {
  const order: Field[] = includeVin ? ['vin', 'serial', 'imei', 'iccid'] : ['serial', 'imei', 'iccid'];

  const [stage, setStage] = useState<Stage>(order[0]);
  const [data, setData] = useState<{ vin?: string; serial?: string; imei?: string; iccid?: string }>(
    includeVin ? {} : { vin: lockedVin },
  );
  const [pending, setPending] = useState<string | null>(null);
  const [manual, setManual] = useState('');
  const [mode, setMode] = useState<'camera' | 'text'>('camera');
  const [unit, setUnit] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setStage(order[0]);
    setData(includeVin ? {} : { vin: lockedVin });
    setPending(null);
    setManual('');
    setUnit('');
    setError('');
  };

  const advance = (value: string) => {
    const next = { ...data, [stage as Field]: value };
    setData(next);
    setPending(null);
    setManual('');
    setError('');
    const idx = order.indexOf(stage as Field);
    setStage(idx < order.length - 1 ? order[idx + 1] : 'review');
  };

  const confirmPending = () => { if (pending) advance(pending); };

  const submitManual = () => {
    if (stage === 'review') return;
    if (stage === 'vin') {
      const v = manual.trim().toUpperCase();
      if (v.length < 5) { setError('VIN too short'); return; }
      advance(v);
      return;
    }
    const accepted = VALIDATORS[stage](manual);
    if (!accepted) { setError(`Invalid ${LABELS[stage]} — check the number and try again`); return; }
    advance(accepted);
  };

  const submit = async () => {
    if (!data.vin || !data.serial || !data.imei || !data.iccid) { setError('Missing one or more required fields'); return; }
    setSubmitting(true);
    const err = await onComplete({
      vin: data.vin, serial_number: data.serial, imei: data.imei, iccid: data.iccid,
      unit_number: unit.trim() || null,
    });
    setSubmitting(false);
    if (err) { setError(err); return; }
    reset();
    onLogged?.();
  };

  const stepNum = order.indexOf(stage as Field) + 1;

  return (
    <div>
      {/* Progress chips */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' }}>
        {order.map(f => {
          const val = data[f];
          const isCurrent = stage === f;
          const locked = f === 'vin' && !includeVin;
          return (
            <button key={f} type="button" onClick={() => { if (!locked && (val || isCurrent)) { setPending(null); setManual(''); setError(''); setStage(f); } }}
              disabled={locked || (!val && !isCurrent)} style={{
                flex: '1 1 0', minWidth: '70px', padding: '8px 6px', borderRadius: '8px', textAlign: 'left',
                border: `1px solid ${val ? 'rgba(34,197,94,0.4)' : isCurrent ? 'rgba(59,130,246,0.5)' : theme.border}`,
                background: val ? 'rgba(34,197,94,0.06)' : isCurrent ? 'rgba(59,130,246,0.08)' : theme.card,
                cursor: (!locked && (val || isCurrent)) ? 'pointer' : 'default', opacity: (val || isCurrent) ? 1 : 0.5,
              }}>
              <div style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.4px', color: theme.textMuted, textTransform: 'uppercase' }}>{LABELS[f]}</div>
              <div style={{ fontSize: '11px', fontWeight: 700, fontFamily: 'monospace', color: val ? '#22c55e' : theme.textMuted, marginTop: '2px', wordBreak: 'break-all' }}>
                {val ? (val.length > 10 ? `…${val.slice(-9)}` : val) : isCurrent ? 'scanning…' : '—'}
              </div>
            </button>
          );
        })}
      </div>

      {stage !== 'review' ? (
        <>
          <div style={{ display: 'flex', gap: '4px', marginBottom: '10px', background: theme.card, borderRadius: '10px', padding: '3px' }}>
            <button type="button" onClick={() => setMode('camera')} style={{
              flex: 1, padding: '8px', borderRadius: '6px', fontSize: '12px', fontWeight: 700, border: 'none',
              background: mode === 'camera' ? 'var(--tab-active-bg)' : 'transparent', color: mode === 'camera' ? 'var(--tab-active-color)' : theme.textMuted,
            }}>Camera</button>
            <button type="button" onClick={() => { setMode('text'); setPending(null); }} style={{
              flex: 1, padding: '8px', borderRadius: '6px', fontSize: '12px', fontWeight: 700, border: 'none',
              background: mode === 'text' ? 'var(--tab-active-bg)' : 'transparent', color: mode === 'text' ? 'var(--tab-active-color)' : theme.textMuted,
            }}>Type / Scanner</button>
          </div>

          <div style={{ fontSize: '12px', fontWeight: 700, color: theme.textPrimary, marginBottom: '8px' }}>
            Step {stepNum} of {order.length} — scan the <span style={{ color: '#60a5fa' }}>{LABELS[stage]}</span>
          </div>

          {mode === 'camera' ? (
            <div>
              <VinScanner
                onScan={(val) => { setError(''); setPending(val); }}
                continuous
                paused={!!pending}
                validate={stage === 'vin' ? undefined : VALIDATORS[stage]}
                scanLabel={LABELS[stage]}
                theme={theme}
              />
              {pending && (
                <div style={{ marginTop: '8px', padding: '14px', borderRadius: '12px', background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.3)' }}>
                  <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>Captured {LABELS[stage]}</div>
                  <div style={{ fontSize: '16px', fontWeight: 800, fontFamily: 'monospace', letterSpacing: '1px', color: theme.textPrimary, marginBottom: '10px', wordBreak: 'break-all' }}>{pending}</div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button type="button" onClick={confirmPending} style={{ flex: 1, padding: '14px', borderRadius: '10px', fontSize: '15px', fontWeight: 800, background: '#22c55e', color: '#fff', border: 'none', cursor: 'pointer' }}>
                      {stage === order[order.length - 1] ? 'Confirm — Review' : 'Confirm & Next'}
                    </button>
                    <button type="button" onClick={() => { setPending(null); setError(''); }} style={{ padding: '14px 18px', borderRadius: '10px', fontSize: '13px', fontWeight: 700, background: 'transparent', border: `1px solid ${theme.border}`, color: theme.textMuted, cursor: 'pointer' }}>Rescan</button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', gap: '8px' }}>
              <input value={manual} onChange={e => setManual(e.target.value.toUpperCase())} onKeyDown={e => { if (e.key === 'Enter' && manual.trim()) submitManual(); }} placeholder={`Scan or type ${LABELS[stage]}...`} autoFocus style={{
                flex: 1, padding: '14px 16px', borderRadius: '12px', fontSize: '16px', fontFamily: 'monospace', fontWeight: 700, letterSpacing: '1px',
                border: `1px solid ${theme.border}`, background: theme.card, color: theme.textPrimary,
              }} />
              <button type="button" onClick={submitManual} disabled={!manual.trim()} style={{
                padding: '14px 20px', borderRadius: '12px', fontSize: '15px', fontWeight: 800,
                background: !manual.trim() ? theme.border : theme.navy, color: '#fff', border: 'none',
                cursor: !manual.trim() ? 'default' : 'pointer', opacity: !manual.trim() ? 0.5 : 1,
              }}>Next</button>
            </div>
          )}
        </>
      ) : (
        <div style={{ padding: '14px', borderRadius: '12px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)' }}>
          <div style={{ fontSize: '11px', fontWeight: 800, color: theme.textPrimary, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '10px' }}>Review device</div>
          {order.map(f => (
            <div key={f} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: `1px solid ${theme.border}` }}>
              <div>
                <div style={{ fontSize: '9px', fontWeight: 800, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.4px' }}>{LABELS[f]}</div>
                <div style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'monospace', color: theme.textPrimary, wordBreak: 'break-all' }}>{data[f] || '—'}</div>
              </div>
              {!(f === 'vin' && !includeVin) && (
                <button type="button" onClick={() => { setPending(null); setManual(''); setError(''); setStage(f); }} style={{ padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'rgba(107,114,128,0.08)', border: '1px solid rgba(107,114,128,0.2)', color: '#6b7280', cursor: 'pointer', flexShrink: 0 }}>Redo</button>
              )}
            </div>
          ))}
          {showUnit && (
            <>
              <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px', margin: '10px 0 4px' }}>Unit # (optional)</div>
              <input value={unit} onChange={e => setUnit(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !submitting) submit(); }} placeholder="e.g. 4012" style={{
                width: '100%', padding: '12px 14px', borderRadius: '10px', fontSize: '15px', fontWeight: 700,
                border: `1px solid ${theme.border}`, background: theme.card, color: theme.textPrimary, marginBottom: '10px',
              }} />
            </>
          )}
          <button type="button" onClick={submit} disabled={submitting} style={{
            width: '100%', marginTop: showUnit ? 0 : '12px', padding: '14px', borderRadius: '10px', fontSize: '15px', fontWeight: 800,
            background: submitting ? theme.border : '#22c55e', color: '#fff', border: 'none', cursor: submitting ? 'default' : 'pointer', opacity: submitting ? 0.6 : 1,
          }}>{submitting ? 'Saving...' : 'Log & Scan Next'}</button>
        </div>
      )}

      {error && (
        <div style={{ marginTop: '10px', padding: '8px 12px', borderRadius: '8px', background: theme.errorBg || 'rgba(239,68,68,0.1)', border: `1px solid ${theme.errorBorder || 'rgba(239,68,68,0.3)'}`, color: theme.error || '#ef4444', fontSize: '12px', fontWeight: 600 }}>{error}</div>
      )}
    </div>
  );
}
