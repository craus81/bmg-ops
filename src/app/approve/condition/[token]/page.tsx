'use client';

/**
 * The public vehicle-condition acknowledgment page (R6-10).
 *
 * Rides ApprovalPageShell so the token fetch, state machine and E-SIGN
 * forensics are the same ones estimates and proofs already use. What
 * differs is only the meaning of the two buttons: accepting says the
 * recorded condition is accurate, and "request changes" says it isn't —
 * which the shop wants to hear at the counter, not six weeks later.
 */

import ApprovalPageShell from '@/components/ApprovalPageShell';
import { CONDITION_AGREEMENT_TEXT } from '@/lib/vehicle-condition';

const TONE: Record<string, string> = {
  Severe: '#f87171', Moderate: '#f59e0b', Minor: '#94a3b8',
};

export default function ConditionAcknowledgmentPage() {
  return (
    <ApprovalPageShell
      kind="condition"
      noun="condition report"
      agreementText={CONDITION_AGREEMENT_TEXT}
      parsePayload={json => json.condition}
      docLabel={d => (d?.vehicle ? `${d.vehicle}${d.vin ? ` · VIN ${String(d.vin).slice(-8)}` : ''}` : null)}
      acceptedAt={d => d?.acknowledgedAt || null}
      copy={{
        invalid: 'This condition-report link is not valid. Ask BMG to send a fresh one.',
        expired: 'This condition-report link has expired. Ask BMG to send a fresh one.',
        acceptLabel: 'Confirm this is accurate',
        rejectSendLabel: 'Send correction to BMG',
        rejectPlaceholder: 'What is wrong or missing? (e.g. the dent on the rear bumper isn’t listed)',
        acceptedTitle: 'Condition acknowledged',
        rejectedTitle: 'Correction sent to BMG',
      }}
      renderDocument={d => (
        <div>
          <div style={{ marginBottom: '14px' }}>
            <div style={{ fontSize: '17px', fontWeight: 800 }}>{d.vehicle}</div>
            <div style={{ fontSize: '12px', color: '#64748b' }}>
              VIN {d.vin}{d.customerName ? ` · ${d.customerName}` : ''}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap', marginBottom: '16px', fontSize: '13px' }}>
            <div>
              <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.6px', color: '#94a3b8' }}>Odometer</div>
              {/* "not recorded" rather than 0 — an unread gauge is not a reading. */}
              <div style={{ fontWeight: 700 }}>{d.odometer || 'Not recorded'}</div>
            </div>
            <div>
              <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.6px', color: '#94a3b8' }}>Fuel</div>
              <div style={{ fontWeight: 700 }}>{d.fuel || 'Not recorded'}</div>
            </div>
          </div>

          <div style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.6px', color: '#94a3b8', marginBottom: '8px' }}>
            Pre-existing damage
          </div>

          {d.findings.length === 0 ? (
            <div style={{ fontSize: '13px', color: '#475569', padding: '10px 0' }}>
              {d.legacyNote || 'No pre-existing damage was recorded when this vehicle arrived.'}
            </div>
          ) : (
            d.findings.map((f: any) => (
              <div key={f.id} style={{ padding: '11px 0', borderTop: '1px solid #e2e8f0' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                  <span style={{
                    fontSize: '10px', fontWeight: 800, padding: '2px 7px', borderRadius: '5px',
                    background: `${TONE[f.severityLabel] || '#94a3b8'}22`,
                    color: TONE[f.severityLabel] || '#94a3b8',
                  }}>{f.severityLabel}</span>
                  {f.location && <span style={{ fontSize: '13px', fontWeight: 700 }}>{f.location}</span>}
                </div>
                <div style={{ fontSize: '13px', color: '#334155', marginTop: '4px' }}>{f.description}</div>
                {f.photos.length > 0 && (
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
                    {f.photos.map((p: any, i: number) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={i} src={p.url} alt={`${f.location || 'Damage'} ${i + 1}`}
                        style={{ width: '96px', height: '96px', objectFit: 'cover', borderRadius: '8px', border: '1px solid #e2e8f0' }}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))
          )}

          <div style={{ marginTop: '16px', fontSize: '11.5px', color: '#64748b', lineHeight: 1.5 }}>
            This is the condition BMG recorded when your vehicle arrived. Confirming it does not
            waive any claim — it records that you and BMG agree on the vehicle’s starting condition.
          </div>
        </div>
      )}
    />
  );
}
