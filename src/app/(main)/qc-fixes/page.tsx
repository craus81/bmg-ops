'use client';

/**
 * QC Fixes (migration 381) — issues a customer's QC team (Masterack) reports
 * on vehicles we finished, through their QC link. Replaces the monday.com
 * QC fix board (owner ask 2026-10-15), kept simple:
 *
 *   New        reported, waiting on a fix-by date
 *   Scheduled  fix-by date set (their link shows it), soonest first
 *   Fixed      done
 *
 * "Mark fixed…" opens the standard email screen addressed to the
 * customer's QC contacts (Ron and Chaquanna), with any photo of the fix;
 * sending marks it fixed. Nothing emails them on its own from here (owner:
 * "i dont like automatic emails"). "Mark fixed without emailing" is there
 * for the ones that need no note.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import EmailComposeModal, { type EmailComposeAttachment } from '@/components/EmailComposeModal';
import CustomerPicker from '@/components/CustomerPicker';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import { shrinkPhotoForUpload } from '@/lib/photo-upload-shrink';
import { fmtQcDate, qcStatusLabel, type QcStatus } from '@/lib/qc-fixes';

interface Photo { id: string; kind: 'vin' | 'issue' | 'fix'; file_name: string; size_bytes: number | null; url: string | null }
interface Report {
  id: string;
  customer_id: string;
  customer_name: string | null;
  customer_emails: string[];
  vin_last6: string;
  vin: string | null;
  checkin_id: string | null;
  vehicle_label: string | null;
  reported_by_name: string;
  comments: string | null;
  status: QcStatus;
  fix_by: string | null;
  note_to_customer: string | null;
  fixed_at: string | null;
  fixed_by_name: string | null;
  fixed_email_sent_at: string | null;
  created_at: string;
  photos: Photo[];
}
interface QcLink { customerId: string; customerName: string | null; url: string; createdAt: string | null; emails: string[] }

const fmtWhen = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', {
  timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}) : '');

const btn = (primary = false, color?: string): React.CSSProperties => ({
  display: 'inline-block', padding: '10px 16px', borderRadius: '8px', fontSize: '14px', fontWeight: 800,
  cursor: 'pointer', textDecoration: 'none', whiteSpace: 'nowrap',
  background: primary ? (color || 'var(--accent, #2563eb)') : 'transparent',
  color: primary ? '#fff' : 'var(--text-primary)',
  border: primary ? `1px solid ${color || 'var(--accent, #2563eb)'}` : '1px solid var(--border-strong)',
});
const field: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '9px 10px', borderRadius: 8, border: '1px solid var(--border-strong)',
  background: 'var(--input-bg, transparent)', color: 'var(--text-primary)', fontSize: 14, fontFamily: 'inherit',
};
const STATUS_COLOR: Record<QcStatus, string> = { new: '#ef4444', scheduled: '#f59e0b', fixed: '#16a34a' };

function Chip({ status }: { status: QcStatus }) {
  const c = STATUS_COLOR[status];
  return <span style={{ display: 'inline-block', padding: '2px 9px', borderRadius: 999, fontSize: 11, fontWeight: 800, color: c, background: `${c}1f`, border: `1px solid ${c}55`, whiteSpace: 'nowrap' }}>{qcStatusLabel(status)}</span>;
}

function LinksCard({ isAdmin }: { isAdmin: boolean }) {
  const dialog = useDialog();
  const [links, setLinks] = useState<QcLink[] | null>(null);
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState('');
  const [pickNs, setPickNs] = useState<string | null>(null);
  const [emailsDraft, setEmailsDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await apiFetch('/api/qc-fixes/link');
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      setLinks(json.links || []);
      setEmailsDraft(Object.fromEntries((json.links || []).map((l: QcLink) => [l.customerId, l.emails.join(', ')])));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await apiFetch('/api/qc-fixes/link', { method: 'POST', body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Could not save');
      await load();
      return true;
    } catch (e: any) {
      await dialog.alert(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const copy = async (l: QcLink) => {
    try { await navigator.clipboard.writeText(l.url); setCopied(l.customerId); setTimeout(() => setCopied(null), 1500); }
    catch { await dialog.alert(l.url, { title: 'QC link' }); }
  };

  if (!links) return null;
  const summary = links.length === 0 ? 'No customer has a QC link yet.' : links.map(l => l.customerName).join(', ');
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: '10px 14px', marginBottom: 14 }}>
      <button onClick={() => setOpen(o => !o)} style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-primary)', fontFamily: 'inherit' }}>
        <span style={{ fontWeight: 800, fontSize: 14 }}>🔗 Customer QC links <span style={{ fontWeight: 500, color: 'var(--text-secondary)', fontSize: 13 }}>· {summary}</span></span>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div style={{ marginTop: 10 }}>
          {links.map(l => (
            <div key={l.customerId} style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <span style={{ fontWeight: 800, color: 'var(--text-primary)', flex: '1 1 160px' }}>{l.customerName}</span>
                <button onClick={() => copy(l)} style={{ ...btn(true), padding: '6px 12px', fontSize: 13 }}>{copied === l.customerId ? '✓ Copied' : 'Copy link'}</button>
                <a href={l.url} target="_blank" rel="noreferrer" style={{ ...btn(), padding: '6px 12px', fontSize: 13 }}>Open</a>
                {isAdmin && <button disabled={busy} onClick={async () => { if (await dialog.confirm(`Make a new link for ${l.customerName}? The current link stops working, so you'll need to send them the new one.`, { title: 'New link', confirmLabel: 'Make new link' })) act({ customerId: l.customerId, action: 'regenerate' }); }} style={{ ...btn(), padding: '6px 12px', fontSize: 13 }}>New link</button>}
                {isAdmin && <button disabled={busy} onClick={async () => { if (await dialog.confirm(`Turn off ${l.customerName}'s QC link? Nobody can report through it until you make a new one.`, { title: 'Turn off link', confirmLabel: 'Turn off', destructive: true })) act({ customerId: l.customerId, action: 'revoke' }); }} style={{ ...btn(), padding: '6px 12px', fontSize: 13, color: '#dc2626' }}>Turn off</button>}
              </div>
              <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
                Emailed when their team reports an issue{isAdmin ? ' (comma separated)' : ''}:
                {isAdmin ? (
                  <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                    <input value={emailsDraft[l.customerId] ?? ''} onChange={e => setEmailsDraft(d => ({ ...d, [l.customerId]: e.target.value }))} placeholder="name@company.com, name2@company.com" style={field} />
                    <button disabled={busy} onClick={() => act({ customerId: l.customerId, action: 'emails', emails: (emailsDraft[l.customerId] || '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean) })} style={{ ...btn(), padding: '6px 12px', fontSize: 13 }}>Save</button>
                  </div>
                ) : <span style={{ color: 'var(--text-primary)' }}> {l.emails.join(', ') || 'nobody yet'}</span>}
              </div>
            </div>
          ))}
          {isAdmin && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', paddingTop: 10, borderTop: '1px solid var(--border)' }}>
              <div style={{ flex: '1 1 240px' }}>
                <CustomerPicker value={pick} netsuiteId={pickNs} allowCreate={false} placeholder="Give another customer a QC link…" onChange={r => { setPick(r.customer); setPickNs(r.customerNetsuiteId); }} />
              </div>
              <button disabled={busy || !pickNs} onClick={async () => { if (await act({ customerNetsuiteId: pickNs, action: 'create' })) { setPick(''); setPickNs(null); } }} style={{ ...btn(true), padding: '8px 14px', fontSize: 13, opacity: pickNs ? 1 : 0.5 }}>Make link</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function QcFixes() {
  const router = useRouter();
  const params = useSearchParams();
  const openId = params.get('id');
  const dialog = useDialog();
  const { isAdmin, loading: authLoading, hasFeature } = useAuth();
  const isStaff = hasFeature('qc_fixes');

  const [show, setShow] = useState<QcStatus>('new');
  const [reports, setReports] = useState<Report[]>([]);
  const [counts, setCounts] = useState({ new: 0, scheduled: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fixBy, setFixBy] = useState('');
  const [note, setNote] = useState('');
  const [composing, setComposing] = useState(false);
  const [extraFixPhotos, setExtraFixPhotos] = useState<EmailComposeAttachment[]>([]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const q = new URLSearchParams({ show });
      if (openId) q.set('id', openId);
      const res = await apiFetch(`/api/qc-fixes?${q}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not load QC fixes');
      setReports(json.reports || []);
      setCounts({ new: json.newCount || 0, scheduled: json.scheduledCount || 0 });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [show, openId]);
  useEffect(() => { if (!authLoading && isStaff) load(); }, [authLoading, isStaff, load]);

  const current = useMemo(() => reports.find(r => r.id === openId) || null, [reports, openId]);
  const listed = useMemo(() => reports.filter(r => r.status === show), [reports, show]);
  useEffect(() => {
    setFixBy(current?.fix_by || '');
    setNote(current?.note_to_customer || '');
    setExtraFixPhotos([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (current?.id && cardRef.current && window.matchMedia('(max-width: 760px)').matches) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [current?.id]);
  const open = (id: string | null) => router.replace(id ? deepLinks.qcFix(id) : deepLinks.qcFixes(), { scroll: false });

  const patch = async (body: Record<string, unknown>) => {
    if (!current) return false;
    setBusy(true);
    try {
      const res = await apiFetch('/api/qc-fixes', { method: 'PATCH', body: JSON.stringify({ id: current.id, ...body }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Could not save');
      await load();
      return true;
    } catch (e: any) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const fixPhotos: EmailComposeAttachment[] = useMemo(() => {
    const saved = (current?.photos || []).filter(p => p.kind === 'fix').map(p => ({ id: p.id, name: p.file_name, sizeBytes: p.size_bytes, removable: true }));
    return [...saved, ...extraFixPhotos.filter(x => !saved.some(s => s.id === x.id))];
  }, [current, extraFixPhotos]);

  const emailBody = (fields: { emails: string[]; bccSelf: boolean; cc: string[]; message: string; attachmentIds: string[] }, preview: boolean) =>
    JSON.stringify({ id: current!.id, emails: fields.emails, bccSelf: fields.bccSelf, cc: fields.cc, message: fields.message, attachmentIds: fields.attachmentIds, preview });

  if (authLoading) return null;
  if (!isStaff) return <div style={{ padding: 24, color: 'var(--text-secondary)' }}>This page is for BMG staff.</div>;

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '16px' }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', margin: '0 0 4px' }}>QC Fixes</h1>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
        Issues a customer&apos;s QC team reports on vehicles we finished. Set a fix-by date, then mark it fixed.
      </div>
      <LinksCard isAdmin={isAdmin} />
      {error && <div style={{ padding: '10px 12px', borderRadius: 8, background: 'rgba(239,68,68,0.12)', color: '#ef4444', marginBottom: 12, fontSize: 14 }}>{error}</div>}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 300px', minWidth: 0, maxWidth: current ? 380 : undefined }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            {(['new', 'scheduled', 'fixed'] as const).map(s => (
              <button key={s} onClick={() => setShow(s)} style={{ ...btn(show === s), padding: '7px 12px', fontSize: 13 }}>
                {qcStatusLabel(s)}{s !== 'fixed' && counts[s] ? ` · ${counts[s]}` : ''}
              </button>
            ))}
          </div>
          {loading ? <div style={{ color: 'var(--text-secondary)', fontSize: 14 }}>Loading…</div>
            : listed.length === 0 ? <div style={{ color: 'var(--text-secondary)', fontSize: 14, padding: '20px 0' }}>{show === 'new' ? 'Nothing waiting on a fix-by date.' : show === 'scheduled' ? 'Nothing scheduled.' : 'Nothing fixed yet.'}</div>
              : listed.map(r => {
                const thumb = r.photos.find(p => p.kind === 'issue') || r.photos[0];
                const late = r.status === 'scheduled' && r.fix_by && r.fix_by < new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
                return (
                  <button key={r.id} onClick={() => open(r.id)} style={{
                    display: 'flex', gap: 10, alignItems: 'center', width: '100%', textAlign: 'left', cursor: 'pointer', marginBottom: 8, padding: '10px 12px', borderRadius: 10,
                    background: r.id === openId ? 'var(--surface-2, rgba(37,99,235,0.08))' : 'var(--surface-1, transparent)',
                    border: `1px solid ${r.id === openId ? 'var(--accent, #2563eb)' : 'var(--border)'}`, color: 'var(--text-primary)', fontFamily: 'inherit',
                  }}>
                    {thumb?.url
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <img src={thumb.url} alt="" style={{ width: 52, height: 52, borderRadius: 8, objectFit: 'cover', flex: 'none' }} />
                      : <div style={{ width: 52, height: 52, borderRadius: 8, background: 'var(--border)', flex: 'none' }} />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ fontWeight: 800, fontSize: 14 }}>…{r.vin_last6}</span>
                        <span style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{r.customer_name}</span>
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.vehicle_label || r.comments || 'No comments'}</div>
                      <div style={{ fontSize: 12, color: late ? '#ef4444' : 'var(--text-secondary)', marginTop: 2 }}>
                        {r.status === 'scheduled' && r.fix_by ? `Fix by ${fmtQcDate(r.fix_by)}${late ? ' · late' : ''}` : r.status === 'fixed' ? `Fixed ${fmtQcDate(r.fixed_at)}` : `Sent ${fmtWhen(r.created_at)} by ${r.reported_by_name}`}
                      </div>
                    </div>
                  </button>
                );
              })}
        </div>

        {current && (
          <div ref={cardRef} style={{ flex: '2 1 420px', minWidth: 0, padding: 18, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface-1, transparent)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{current.customer_name} · sent {fmtWhen(current.created_at)} by {current.reported_by_name}</div>
              <button onClick={() => open(null)} style={{ ...btn(), padding: '5px 10px', fontSize: 12 }}>Close</button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '10px 0 4px', flexWrap: 'wrap' }}>
              <h2 style={{ fontSize: 20, fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>VIN …{current.vin_last6}</h2>
              <Chip status={current.status} />
            </div>
            <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 10 }}>
              {current.vin
                ? <>{current.vehicle_label ? `${current.vehicle_label} · ` : ''}{current.vin}{current.checkin_id && <> · <a href={deepLinks.vehicle(current.checkin_id)} style={{ color: 'var(--accent, #2563eb)', fontWeight: 700, textDecoration: 'none' }}>Open vehicle ›</a></>}</>
                : 'No vehicle in FleetSuite matches these last 6 (or more than one does).'}
            </div>
            {current.comments && <p style={{ fontSize: 15, lineHeight: 1.55, color: 'var(--text-primary)', margin: '0 0 12px', whiteSpace: 'pre-wrap' }}>{current.comments}</p>}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
              {current.photos.map(p => (
                <a key={p.id} href={p.url || '#'} target="_blank" rel="noreferrer" style={{ position: 'relative', display: 'block' }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.url || ''} alt={p.file_name} style={{ width: 150, height: 112, objectFit: 'cover', borderRadius: 10, border: p.kind === 'fix' ? '2px solid #16a34a' : '1px solid var(--border)' }} />
                  <span style={{ position: 'absolute', left: 6, bottom: 6, fontSize: 11, fontWeight: 800, color: '#fff', background: 'rgba(0,0,0,.55)', padding: '1px 6px', borderRadius: 6 }}>{p.kind === 'vin' ? 'VIN' : p.kind === 'fix' ? 'Fix' : 'Issue'}</span>
                </a>
              ))}
            </div>

            {current.status !== 'fixed' ? (
              <div style={{ padding: 14, borderRadius: 12, border: '1px solid var(--border-strong)' }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 4 }}>Fix by</label>
                <input type="date" value={fixBy} onChange={e => setFixBy(e.target.value)} style={{ ...field, maxWidth: 220, marginBottom: 10 }} />
                <label style={{ display: 'block', fontSize: 13, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 4 }}>Note to {current.customer_name || 'the customer'} <span style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>(optional, shows on their link)</span></label>
                <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} maxLength={1000} style={{ ...field, resize: 'vertical', marginBottom: 10 }} />
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  <button disabled={busy || (fixBy === (current.fix_by || '') && note === (current.note_to_customer || ''))} onClick={() => patch({ fixBy: fixBy || null, note })} style={btn(true, '#ee3120')}>Save fix-by date</button>
                  <button disabled={busy} onClick={() => setComposing(true)} style={btn(true, '#16a34a')}>✓ Mark fixed…</button>
                  <button disabled={busy} onClick={async () => { if (await dialog.confirm('Mark this fixed without emailing anyone?', { title: 'Mark fixed', confirmLabel: 'Mark fixed' })) patch({ fixed: true }); }} style={{ ...btn(), fontSize: 13 }}>Mark fixed without emailing</button>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
                  Mark fixed opens the email to {current.customer_emails.length ? current.customer_emails.join(', ') : 'their QC contacts'} so you can add a photo of the fix and send it.
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border-strong)', fontSize: 14, color: 'var(--text-primary)' }}>
                <span style={{ flex: '1 1 240px' }}>
                  <b style={{ color: '#16a34a' }}>✓ Fixed {fmtQcDate(current.fixed_at)}</b>
                  {current.fixed_by_name ? ` by ${current.fixed_by_name}` : ''}
                  {current.fixed_email_sent_at ? ` · emailed ${fmtWhen(current.fixed_email_sent_at)}` : ' · no email sent'}
                </span>
                {!current.fixed_email_sent_at && <button disabled={busy} onClick={() => setComposing(true)} style={{ ...btn(), padding: '6px 12px', fontSize: 13 }}>✉ Email them</button>}
                <button disabled={busy} onClick={() => patch({ fixed: false })} style={{ ...btn(), padding: '6px 12px', fontSize: 13 }}>Reopen</button>
              </div>
            )}
          </div>
        )}
      </div>

      {composing && current && (
        <EmailComposeModal
          title={`Mark fixed · VIN …${current.vin_last6}`}
          stateKey={`qc-fixed:${current.id}`}
          initialTo={current.customer_emails.join(', ')}
          intro={<div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>Sending marks this fixed. Photos you add of the fix show in the email and on their link.</div>}
          attachments={fixPhotos}
          initialAttachmentIds={fixPhotos.map(p => p.id)}
          uploadAccept="image/*,.heic,.heif"
          uploadHint="Add a photo of the fix (optional)."
          onUploadAttachment={async file => {
            try {
              const small = await shrinkPhotoForUpload(file);
              const body = new FormData();
              body.append('file', small);
              body.append('reportId', current.id);
              const res = await apiFetch('/api/qc-fixes/photo', { method: 'POST', body });
              const json = await res.json().catch(() => ({}));
              if (!res.ok || !json.id) return { error: json.error || 'Upload failed' };
              setExtraFixPhotos(prev => [...prev, { id: json.id, name: json.name || small.name, sizeBytes: json.sizeBytes ?? small.size, removable: true }]);
              return { id: json.id };
            } catch (e: any) {
              return { error: e.message || 'Upload failed' };
            }
          }}
          onRemoveAttachment={async id => {
            const res = await apiFetch(`/api/qc-fixes/photo?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
            if (res.ok) setExtraFixPhotos(prev => prev.filter(p => p.id !== id));
            return { ok: res.ok };
          }}
          messagePlaceholder="Optional note, e.g. what we did"
          sendLabel="Send and mark fixed"
          fetchPreview={async fields => {
            const res = await apiFetch('/api/qc-fixes/fixed-email', { method: 'POST', body: emailBody(fields, true) });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) return { error: json.error || 'Could not build the preview' };
            return { preview: { to: json.to, subject: json.subject, html: json.html } };
          }}
          onSend={async fields => {
            const res = await apiFetch('/api/qc-fixes/fixed-email', { method: 'POST', body: emailBody(fields, false) });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) { await dialog.alert(json.error || 'Could not send'); return { ok: false }; }
            setComposing(false);
            await load();
            await dialog.alert(`Emailed ${(json.to || []).join(', ')} and marked fixed.`, { title: 'Sent' });
            return { ok: true };
          }}
          onClose={() => { setComposing(false); load(); }}
        />
      )}
    </div>
  );
}

export default function QcFixesPage() {
  return <Suspense fallback={null}><QcFixes /></Suspense>;
}
