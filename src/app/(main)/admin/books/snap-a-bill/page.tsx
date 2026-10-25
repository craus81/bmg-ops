'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import PhotoLightbox from '@/components/PhotoLightbox';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import { isHeicFile } from '@/lib/heic';
import { shrinkPhotoForUpload } from '@/lib/photo-upload-shrink';
import { uploadRecordFile } from '@/lib/record-file-upload';
import { parseDollars } from '@/lib/books/typed-dollars';
import type { BillRead } from '@/lib/books/bill-reader';
import type { SnapForm, SnapLine, SnapNote, SnapView } from '@/lib/books/snap-a-bill';

/**
 * Books → Snap a bill (migration 436, src/lib/books/snap-a-bill.ts and
 * bill-reader.ts, docs/books.md "Snap a bill"; owner decision 2026-10-25,
 * "Snap a bill", as Books Previews drew it).
 *
 * A super admin takes a picture of a vendor's bill, or picks its PDF.
 * FleetSuite reads it and fills in the form: the vendor matched to NetSuite's,
 * the bill number and dates, the due date from their terms, each line with
 * the account their earlier bills went to. Each box is checked against the
 * bill; what's still to do before Send to NetSuite is said under the lines in
 * red, and a bill NetSuite already has can't be sent at all. Sent, the bill
 * is in NetSuite and Books keeps its own copy (Own bills). Save for later
 * keeps it here; Throw it away keeps it, picture and all, marked thrown away.
 * Super admins only, as the books are.
 */

const API = '/api/admin/books/snap-a-bill';

interface Setup {
  companies: Array<{ code: string; name: string; linked: boolean; locations: Array<{ id: string; name: string }> }>;
  accounts: Array<{ id: string; label: string; companies: string[] }>;
}

interface Bill {
  id: string;
  status: 'draft' | 'sent' | 'thrown_away';
  form: SnapForm;
  read: BillRead | null;
  fileType: string;
  fileName: string | null;
  readAt: string | null;
  readError: string | null;
  sendError: string | null;
  /** A Send failed, or NetSuite has the bill and it couldn't be marked sent: Mark it sent can finish it. */
  sendUnfinished: boolean;
  netsuiteId: string | null;
  netsuiteNumber: string | null;
  netsuiteUrl: string | null;
  sentAt: string | null;
  sentBy: string | null;
  thrownAwayAt: string | null;
  thrownAwayBy: string | null;
  madeAt: string;
  madeBy: string | null;
}

interface OneBill {
  bill: Bill;
  view: SnapView | null;
  setup: Setup;
}

interface Draft {
  id: string;
  vendorName: string | null;
  billNumber: string | null;
  billDate: string | null;
  totalCents: number | null;
  read: boolean;
  fileName: string | null;
  savedAt: string;
}

type Busy = '' | 'send' | 'save' | 'throw' | 'mark';
type Stage = 'idle' | 'uploading' | 'reading';

const GREEN = '#22c55e';
const RED = '#ef4444';
const AMBER = '#fbbf24';
const TONE: Record<SnapNote['tone'], string> = { green: GREEN, amber: AMBER, red: RED };

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const fmt = (cents: number) => money.format(cents / 100);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayText = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
const centralDay = (at: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(at));

const banner = (color: string): React.CSSProperties => ({
  padding: '10px 14px', borderRadius: '8px', marginBottom: '10px', fontSize: '13px', fontWeight: 600,
  background: `${color}10`, border: `1px solid ${color}40`, color,
});

const chip = (color: string): React.CSSProperties => ({
  fontSize: '11px', fontWeight: 700, padding: '2px 8px', borderRadius: '999px', whiteSpace: 'nowrap',
  border: `1px solid ${color}55`, color,
});

const bigButton = (kind: 'plain' | 'go' | 'on' = 'plain', disabled = false): React.CSSProperties => ({
  padding: '10px 16px', borderRadius: '10px', fontSize: '14px', fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer',
  border: `1px solid ${kind === 'go' ? `${GREEN}${disabled ? '55' : ''}` : kind === 'on' ? 'var(--text-primary)' : 'var(--border)'}`,
  background: kind === 'go' ? `${GREEN}${disabled ? '0d' : '22'}` : 'var(--card)',
  color: kind === 'go' ? (disabled ? `${GREEN}66` : GREEN) : 'var(--text-primary)',
});

const label: React.CSSProperties = { fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '4px', marginTop: '12px' };

const input = (warn = false): React.CSSProperties => ({
  width: '100%', boxSizing: 'border-box', padding: '9px 10px', borderRadius: '8px', fontSize: '14px', fontFamily: 'inherit',
  border: `1px solid ${warn ? AMBER : 'var(--border)'}`, background: 'var(--bg)', color: 'var(--text-primary)', minWidth: 0,
});

const noteText = (color?: string): React.CSSProperties => ({ fontSize: '12px', marginTop: '4px', color: color ?? 'var(--text-muted)' });

const linkStyle: React.CSSProperties = { color: 'var(--text-secondary)' };

/** A money box: what's typed while it's being typed, the amount as dollars once it isn't. */
function MoneyInput({ cents, onChange, style, placeholder, ariaLabel }: {
  cents: number | null;
  onChange: (cents: number | null) => void;
  style: React.CSSProperties;
  placeholder?: string;
  ariaLabel: string;
}) {
  const [text, setText] = useState(cents === null ? '' : fmt(cents));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(cents === null ? '' : fmt(cents));
  }, [cents]);
  return (
    <input
      inputMode="decimal"
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={text}
      onFocus={() => { focused.current = true; }}
      onBlur={() => {
        focused.current = false;
        setText(cents === null ? text : fmt(cents));
      }}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseDollars(e.target.value));
      }}
      style={style}
    />
  );
}

/** What a line is for: on a narrow screen it wraps onto more rows, rather than hiding the end of it. */
function LineText({ value, onChange, ariaLabel, style }: {
  value: string;
  onChange: (text: string) => void;
  ariaLabel: string;
  style: React.CSSProperties;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const grow = () => {
      const el = box.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
    };
    grow();
    window.addEventListener('resize', grow);
    return () => window.removeEventListener('resize', grow);
  }, [value]);
  return (
    <textarea
      ref={box}
      rows={1}
      value={value}
      maxLength={300}
      // A line goes to NetSuite as one line: Return does nothing, and a pasted line break is a space.
      onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
      onChange={(e) => onChange(e.target.value.replace(/\s*[\r\n]+\s*/g, ' '))}
      placeholder="What it's for"
      aria-label={ariaLabel}
      style={{ ...style, resize: 'none', overflow: 'hidden', display: 'block' }}
    />
  );
}

/** The picture (or the PDF's name) at the top of the card; tap to see it bigger. */
function Thumb({ bill, onOpen }: { bill: Bill; onOpen: () => void }) {
  const url = deepLinks.booksSnapBillFile(bill.id);
  if (bill.fileType === 'application/pdf') {
    return (
      <a
        href={deepLinks.pdfViewer(url, { name: bill.fileName, back: deepLinks.booksSnapBill(bill.id), backLabel: 'Snap a bill' })}
        target="_blank"
        rel="noreferrer"
        style={{
          width: '110px', height: '140px', flex: '0 0 auto', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px', textDecoration: 'none',
          color: 'var(--text-secondary)', padding: '6px', boxSizing: 'border-box', textAlign: 'center',
        }}
      >
        <span style={{ fontSize: '18px', fontWeight: 800 }}>PDF</span>
        <span style={{ fontSize: '10px', overflowWrap: 'anywhere' }}>{bill.fileName ?? 'The bill'}</span>
      </a>
    );
  }
  return (
    <button type="button" onClick={onOpen} aria-label="See the picture bigger" style={{ padding: 0, border: 'none', background: 'none', cursor: 'zoom-in', flex: '0 0 auto' }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a private, same-origin file */}
      <img src={url} alt="The bill" style={{ width: '110px', maxHeight: '150px', objectFit: 'cover', objectPosition: 'top', borderRadius: '6px', border: '1px solid var(--border)', display: 'block' }} />
    </button>
  );
}

export default function BooksSnapBillPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [one, setOne] = useState<OneBill | null>(null);
  const [form, setForm] = useState<SnapForm | null>(null);
  const [view, setView] = useState<SnapView | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [busy, setBusy] = useState<Busy>('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmThrow, setConfirmThrow] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const [vendorHits, setVendorHits] = useState<Array<{ id: string; name: string }>>([]);
  const [vendorSearchError, setVendorSearchError] = useState('');
  const revision = useRef(0);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const post = useCallback(async (body: Record<string, unknown>) => {
    const res = await apiFetch(API, { method: 'POST', body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({ error: `FleetSuite's server returned an error (HTTP ${res.status})` }));
    return { ok: res.ok, json };
  }, []);

  const show = useCallback((payload: OneBill) => {
    revision.current += 1;
    if (checkTimer.current) clearTimeout(checkTimer.current);
    setChecking(false);
    setOne(payload);
    setForm(payload.bill.form);
    setView(payload.view);
    setConfirmThrow(false);
    setVendorHits([]);
    window.history.replaceState(null, '', deepLinks.booksSnapBill(payload.bill.id));
  }, []);

  const loadList = useCallback(async () => {
    try {
      const res = await apiFetch(API);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setDrafts(json.drafts);
    } catch (e: any) {
      setError(e?.message || 'Could not load the bills saved for later');
    }
  }, []);

  const openBill = useCallback(async (id: string) => {
    setError('');
    setNotice('');
    try {
      const res = await apiFetch(`${API}?${new URLSearchParams({ id })}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      show(json);
    } catch (e: any) {
      setError(e?.message || 'Could not open the bill');
      loadList();
    }
  }, [show, loadList]);

  useEffect(() => {
    if (authLoading) return;
    if (!hasRole('super_admin')) { router.push('/home'); return; }
    // Own bills links a snapped bill here by its id (deepLinks.booksSnapBill).
    const id = new URLSearchParams(window.location.search).get('id');
    if (id) openBill(id);
    else loadList();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, openBill, loadList]);

  /** Back to the start: the snap buttons and the bills saved for later. */
  const backToStart = useCallback((message = '') => {
    revision.current += 1;
    if (checkTimer.current) clearTimeout(checkTimer.current);
    setOne(null);
    setForm(null);
    setView(null);
    setChecking(false);
    setConfirmThrow(false);
    setNotice(message);
    window.history.replaceState(null, '', deepLinks.booksSnapBill());
    loadList();
  }, [loadList]);

  const readIt = useCallback(async (id: string) => {
    setStage('reading');
    setError('');
    const { ok, json } = await post({ action: 'read', id }).catch(() => ({ ok: false, json: { error: "Couldn't reach FleetSuite to read the bill. Check your connection and try again." } }));
    setStage('idle');
    if (!ok) { setError(json.error || 'The bill could not be read'); return; }
    show(json);
  }, [post, show]);

  /** Every change to the form: shown at once, and checked once typing stops. */
  const change = (next: SnapForm) => {
    if (!one) return;
    setForm(next);
    setConfirmThrow(false);
    revision.current += 1;
    const mine = revision.current;
    const id = one.bill.id;
    setChecking(true);
    if (checkTimer.current) clearTimeout(checkTimer.current);
    checkTimer.current = setTimeout(async () => {
      const { ok, json } = await post({ action: 'check', id, form: next })
        .catch(() => ({ ok: false, json: { error: "Couldn't reach FleetSuite to check the bill. Check your connection." } }));
      // Typed again since: that change's check is the one that counts.
      if (mine !== revision.current) return;
      setChecking(false);
      if (!ok) { setError(json.error || 'The bill could not be checked'); return; }
      setError('');
      setForm(json.form);
      setView(json.view);
    }, 600);
  };

  const onFile = async (picked: File | undefined) => {
    if (!picked) return;
    setError('');
    setNotice('');
    // A bill open with changes is kept before the next one starts.
    if (one?.bill.status === 'draft' && form) {
      const saved = await post({ action: 'save', id: one.bill.id, form }).catch(() => ({ ok: false, json: { error: "Couldn't reach FleetSuite." } }));
      if (!saved.ok) { setError(`The bill that's open couldn't be saved first, so nothing new was started: ${saved.json.error}`); return; }
    }
    setStage('uploading');
    let file = picked;
    // A PDF can come with no type from some file pickers.
    if (!file.type && /\.pdf$/i.test(file.name)) file = new File([file], file.name, { type: 'application/pdf' });
    if (file.type.startsWith('image/') || isHeicFile(file)) file = await shrinkPhotoForUpload(file);
    const rec = await uploadRecordFile(API, {}, file);
    if (rec.error || !rec.file?.id) {
      setStage('idle');
      setError(rec.error || "The bill didn't upload.");
      return;
    }
    setOne(null);
    setForm(null);
    setView(null);
    await readIt(rec.file.id);
  };

  const act = async (action: 'send' | 'save' | 'throw_away' | 'mark_sent') => {
    if (!one || !form) return;
    setBusy(action === 'send' ? 'send' : action === 'save' ? 'save' : action === 'mark_sent' ? 'mark' : 'throw');
    setError('');
    const { ok, json } = await post({ action, id: one.bill.id, ...(action === 'throw_away' ? {} : { form }) })
      .catch(() => ({ ok: false, json: { error: "Couldn't reach FleetSuite. Check your connection and try again." } }));
    setBusy('');
    if (!ok) {
      setError(json.error || 'That didn\'t work');
      if (json.view) setView(json.view);
      return;
    }
    const who = form.vendorName?.trim() ? `${form.vendorName.trim()}'s bill` : 'The bill';
    if (action === 'save') backToStart(`${who} is saved for later.`);
    else if (action === 'throw_away') backToStart(`${who} is thrown away. Its picture is kept.`);
    else {
      show(json);
      window.scrollTo({ top: 0 });
    }
  };

  const searchVendors = (typed: string) => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (typed.trim().length < 2) { setVendorHits([]); return; }
    searchTimer.current = setTimeout(async () => {
      try {
        const res = await apiFetch(`${API}?${new URLSearchParams({ vendors: typed })}`);
        const json = await res.json().catch(() => ({}));
        setVendorHits(res.ok ? json.vendors ?? [] : []);
        setVendorSearchError(json.error ?? (res.ok ? '' : `Vendor search failed (${res.status})`));
      } catch {
        setVendorSearchError("Couldn't reach FleetSuite to search the vendors.");
      }
    }, 300);
  };

  const bill = one?.bill ?? null;
  const setup = one?.setup ?? null;
  const company = setup && form ? setup.companies.find((c) => c.code === form.company) ?? null : null;
  const accountsFor = setup && form ? setup.accounts.filter((a) => a.companies.includes(form.company)) : [];
  const accountLabel = (id: string) => setup?.accounts.find((a) => a.id === id)?.label ?? `NetSuite account ${id}`;
  // A check of other lines (one just added or taken away) says nothing about these until it comes back.
  const linesChecked = !!view && !!form && view.accounts.length === form.lines.length;
  const setLine = (i: number, patch: Partial<SnapLine>) => form && change({ ...form, lines: form.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });

  return (
    <div style={{ maxWidth: '640px' }}>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '24px', fontWeight: 800 }}>Snap a bill</div>
        <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
          Take a picture of a vendor&apos;s bill, or pick its PDF. FleetSuite reads it, you check it, and it goes into NetSuite as a
          bill. Books keeps its own copy. Visible only to super admins.{' '}
          <Link href={deepLinks.booksOwnBills()} style={linkStyle}>Own bills</Link>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <button type="button" disabled={stage !== 'idle' || !!busy} onClick={() => cameraRef.current?.click()} style={bigButton()}>Take a picture</button>
        <button type="button" disabled={stage !== 'idle' || !!busy} onClick={() => fileRef.current?.click()} style={bigButton()}>Choose a file</button>
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; onFile(f); }} />
        <input ref={fileRef} type="file" accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif" style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; onFile(f); }} />
      </div>

      {error && <div style={banner(RED)}>{error}</div>}
      {notice && <div style={banner(GREEN)}>{notice}</div>}

      {stage !== 'idle' && (
        <div style={{ ...banner('#60a5fa'), fontWeight: 600 }}>
          {stage === 'uploading' ? 'Uploading the bill…' : 'Reading the bill… This can take up to a minute.'}
        </div>
      )}

      {/* The start: the bills saved for later. */}
      {!one && stage === 'idle' && drafts && drafts.length > 0 && (
        <div>
          <div style={{ fontSize: '15px', fontWeight: 800, margin: '6px 0 8px' }}>Saved for later</div>
          <div style={{ border: '1px solid var(--border)', borderRadius: '10px', background: 'var(--card)' }}>
            {drafts.map((d, i) => (
              <button
                key={d.id}
                type="button"
                onClick={() => openBill(d.id)}
                style={{
                  display: 'flex', width: '100%', gap: '10px', justifyContent: 'space-between', alignItems: 'baseline', textAlign: 'left',
                  padding: '10px 12px', border: 'none', borderTop: i ? '1px solid var(--border)' : 'none', background: 'none',
                  color: 'var(--text-primary)', cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <span style={{ fontWeight: 700 }}>{d.vendorName ?? (d.read ? 'No vendor yet' : 'Not read yet')}</span>
                  {d.billNumber && <span style={{ color: 'var(--text-secondary)' }}> · Bill {d.billNumber}</span>}
                  <span style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)' }}>
                    {d.billDate ? `Dated ${dayText(d.billDate)} · ` : ''}Saved {dayText(centralDay(d.savedAt))}
                  </span>
                </span>
                <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{d.totalCents === null ? '' : fmt(d.totalCents)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Sent: the bill is in NetSuite. */}
      {bill && bill.status === 'sent' && (
        <div style={{ border: `1px solid ${GREEN}66`, borderRadius: '12px', padding: '14px', background: 'var(--card)' }}>
          <div style={{ fontSize: '16px', fontWeight: 800, color: GREEN, marginBottom: '4px' }}>Sent to NetSuite</div>
          <div style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
            {bill.form.vendorName ?? 'The vendor'}&apos;s bill {bill.netsuiteNumber ?? bill.form.billNumber}
            {bill.form.totalCents !== null ? ` for ${fmt(bill.form.totalCents)}` : ''} is in NetSuite for {bill.form.company}
            {bill.form.dueDate ? `, due ${dayText(bill.form.dueDate)}` : ''}. Books keeps{' '}
            {bill.netsuiteId ? <Link href={deepLinks.booksOwnBill(bill.netsuiteId)} style={linkStyle}>its own copy</Link> : 'its own copy'}{' '}
            and checks it against NetSuite&apos;s once the bills copy picks it up, within two hours.
          </div>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', marginTop: '12px' }}>
            {bill.netsuiteUrl
              ? <a href={bill.netsuiteUrl} target="_blank" rel="noreferrer" style={{ ...linkStyle, fontSize: '14px' }}>Bill {bill.netsuiteNumber ?? bill.form.billNumber} in NetSuite ↗</a>
              : <span />}
            <button type="button" onClick={() => backToStart()} style={bigButton()}>Snap another</button>
          </div>
          {bill.sentBy && bill.sentAt && (
            <div style={{ ...noteText(), marginTop: '8px' }}>Sent by {bill.sentBy}, {dayText(centralDay(bill.sentAt))}.</div>
          )}
        </div>
      )}

      {/* Thrown away: kept, with its picture. */}
      {bill && bill.status === 'thrown_away' && (
        <div style={{ border: '1px solid var(--border)', borderRadius: '12px', padding: '14px', background: 'var(--card)', display: 'flex', gap: '12px' }}>
          <Thumb bill={bill} onOpen={() => setLightbox(true)} />
          <div>
            <div style={{ fontSize: '16px', fontWeight: 800, marginBottom: '4px' }}>Thrown away</div>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
              {bill.form.vendorName ?? 'This'}{bill.form.vendorName ? "'s bill" : ' bill'}{bill.form.billNumber ? ` ${bill.form.billNumber}` : ''} was thrown
              away{bill.thrownAwayBy ? ` by ${bill.thrownAwayBy}` : ''}{bill.thrownAwayAt ? ` on ${dayText(centralDay(bill.thrownAwayAt))}` : ''}. Its
              picture is kept.
            </div>
            <button type="button" onClick={() => backToStart()} style={{ ...bigButton(), marginTop: '10px' }}>Snap another</button>
          </div>
        </div>
      )}

      {/* The bill to check. */}
      {bill && bill.status === 'draft' && form && setup && (
        <div style={{ border: '1px solid var(--border)', borderRadius: '12px', padding: '14px', background: 'var(--card)' }}>
          {/* Nothing changes while it's being read, saved or sent: the answer would replace it. */}
          <fieldset disabled={!!busy || stage !== 'idle'} style={{ border: 'none', margin: 0, padding: 0, minWidth: 0 }}>
            {bill.sendError && <div style={banner(RED)}>The last try to send it didn&apos;t work: {bill.sendError}</div>}

            <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
              <Thumb bill={bill} onOpen={() => setLightbox(true)} />
              <div style={{ minWidth: 0 }}>
                {bill.readError ? (
                  <>
                    <div style={{ fontSize: '15px', fontWeight: 800, color: RED }}>Couldn&apos;t read it</div>
                    <div style={{ fontSize: '13px', color: RED }}>{bill.readError}</div>
                    <div style={{ ...noteText(), fontSize: '13px' }}>Fill it in by hand, or try reading it again.</div>
                    <button type="button" disabled={stage !== 'idle'} onClick={() => readIt(bill.id)} style={{ ...bigButton(), marginTop: '8px', fontSize: '13px', padding: '7px 12px' }}>Read it again</button>
                  </>
                ) : !bill.readAt ? (
                  <>
                    <div style={{ fontSize: '15px', fontWeight: 800 }}>Not read yet</div>
                    <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>FleetSuite hasn&apos;t read this one. Read it, or fill it in by hand.</div>
                    <button type="button" disabled={stage !== 'idle'} onClick={() => readIt(bill.id)} style={{ ...bigButton(), marginTop: '8px', fontSize: '13px', padding: '7px 12px' }}>Read it</button>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: '15px', fontWeight: 800 }}>Read from the {bill.fileType === 'application/pdf' ? 'PDF' : 'picture'}</div>
                    <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                      Check each box against the bill. Anything FleetSuite couldn&apos;t read is left empty.{' '}
                      {bill.fileType === 'application/pdf' ? 'Tap the PDF to open it.' : 'Tap the picture to see it bigger.'}
                    </div>
                    <button type="button" disabled={stage !== 'idle'} onClick={() => readIt(bill.id)} style={{ ...linkStyle, background: 'none', border: 'none', padding: 0, marginTop: '4px', fontSize: '12px', cursor: 'pointer', textDecoration: 'underline' }}>
                      Read it again
                    </button>
                  </>
                )}
              </div>
            </div>

            <div style={label}>Company</div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {setup.companies.map((c) => (
                <button key={c.code} type="button" onClick={() => change({ ...form, company: c.code })} style={bigButton(form.company === c.code ? 'on' : 'plain')}>
                  {c.code}
                </button>
              ))}
            </div>
            {view?.company && <div style={noteText(AMBER)}>{view.company}</div>}

            {company && company.locations.length > 0 && (
              <>
                <div style={label}>Location</div>
                <select
                  value={form.locationId ?? ''}
                  onChange={(e) => change({ ...form, locationId: e.target.value || null })}
                  style={input(!form.locationId)}
                >
                  {!form.locationId && <option value="">Pick a location</option>}
                  {company.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
                {view?.location.text && view.location.id === form.locationId && <div style={noteText()}>{view.location.text}</div>}
              </>
            )}

            <div style={label}>Vendor</div>
            <div style={{ position: 'relative' }}>
              <input
                value={form.vendorName ?? ''}
                onChange={(e) => {
                  change({ ...form, vendorName: e.target.value, vendorId: null });
                  searchVendors(e.target.value);
                }}
                placeholder="Type to find the vendor in NetSuite"
                autoComplete="off"
                style={input(!form.vendorId)}
              />
              {!form.vendorId && vendorHits.length > 0 && (
                <div style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, marginTop: '2px', border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--card)', boxShadow: '0 6px 20px rgba(0,0,0,0.35)' }}>
                  {vendorHits.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => { setVendorHits([]); change({ ...form, vendorId: v.id, vendorName: v.name }); }}
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 10px', border: 'none', background: 'none', color: 'var(--text-primary)', fontSize: '14px', cursor: 'pointer', fontFamily: 'inherit' }}
                    >
                      {v.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {vendorSearchError && <div style={noteText(RED)}>{vendorSearchError}</div>}
            {view?.vendor.text && <div style={noteText(view.vendor.tone === 'green' ? GREEN : AMBER)}>{view.vendor.text}</div>}
            {view && view.vendor.others.length > 0 && (
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
                {view.vendor.others.map((v) => (
                  <button key={v.id} type="button" onClick={() => change({ ...form, vendorId: v.id, vendorName: v.name })} style={{ ...bigButton(), fontSize: '12px', padding: '5px 10px' }}>
                    {v.name}
                  </button>
                ))}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 10px' }}>
              <div>
                <div style={label}>Bill number</div>
                <input value={form.billNumber ?? ''} maxLength={200} onChange={(e) => change({ ...form, billNumber: e.target.value })} style={input(!form.billNumber?.trim())} />
              </div>
              <div>
                <div style={label}>Bill date</div>
                <input type="date" value={form.billDate ?? ''} onChange={(e) => change({ ...form, billDate: e.target.value || null })} style={input(!form.billDate)} />
              </div>
              <div>
                <div style={label}>Due</div>
                <input type="date" value={form.dueDate ?? ''} onChange={(e) => change({ ...form, dueDate: e.target.value || null, duePicked: true })} style={input()} />
              </div>
              <div>
                <div style={label}>Total on the bill</div>
                <MoneyInput
                  key={`total-${bill.readAt}`}
                  cents={form.totalCents}
                  onChange={(cents) => change({ ...form, totalCents: cents })}
                  ariaLabel="Total on the bill"
                  placeholder="$0.00"
                  style={{ ...input(form.totalCents === null), textAlign: 'right', fontWeight: 700 }}
                />
              </div>
            </div>
            {view?.due.text && (!form.duePicked || form.dueDate === view.due.date) && <div style={noteText()}>{view.due.text}</div>}
            {form.duePicked && view?.due.date && form.dueDate !== view.due.date && (
              <button type="button" onClick={() => change({ ...form, duePicked: false })} style={{ ...linkStyle, background: 'none', border: 'none', padding: 0, marginTop: '4px', fontSize: '12px', cursor: 'pointer', textDecoration: 'underline' }}>
                Use {dayText(view.due.date)}: {view.due.text}
              </button>
            )}

            <div style={label}>Lines</div>
            <div style={{ border: '1px solid var(--border)', borderRadius: '10px' }}>
              {form.lines.map((line, i) => {
                const suggestion = linesChecked ? view!.accounts[i] : null;
                const showNote = suggestion && (line.accountId ? line.accountId === suggestion.accountId : true);
                const options = accountsFor.some((a) => a.id === line.accountId) || !line.accountId
                  ? accountsFor
                  : [{ id: line.accountId, label: accountLabel(line.accountId), companies: [] }, ...accountsFor];
                return (
                  <div key={i} style={{ padding: '10px 12px', borderTop: i ? '1px solid var(--border)' : 'none' }}>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                      <LineText
                        value={line.description}
                        onChange={(description) => setLine(i, { description })}
                        ariaLabel={`Line ${i + 1}: what it's for`}
                        style={{ ...input(), flex: 1, fontWeight: 700, background: 'transparent' }}
                      />
                      <MoneyInput
                        key={`line-${i}-${bill.readAt}-${form.lines.length}`}
                        cents={line.cents}
                        onChange={(cents) => setLine(i, { cents })}
                        ariaLabel={`Line ${i + 1}: amount`}
                        placeholder="$0.00"
                        style={{ ...input(line.cents === null), width: '120px', textAlign: 'right', fontWeight: 700, background: 'transparent' }}
                      />
                    </div>
                    <select
                      value={line.accountId ?? ''}
                      onChange={(e) => setLine(i, { accountId: e.target.value || null, picked: true })}
                      aria-label={`Line ${i + 1}: account`}
                      style={{ ...input(!line.accountId), marginTop: '8px' }}
                    >
                      {!line.accountId && <option value="">Pick an account</option>}
                      {options.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                    </select>
                    <div style={{ display: 'flex', gap: '8px', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={noteText(line.accountId ? undefined : AMBER)}>{showNote ? suggestion!.text : ''}</div>
                      <button
                        type="button"
                        onClick={() => change({ ...form, lines: form.lines.filter((_, j) => j !== i) })}
                        style={{ background: 'none', border: 'none', padding: '4px 0 0', fontSize: '12px', color: 'var(--text-muted)', cursor: 'pointer', whiteSpace: 'nowrap' }}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                );
              })}
              <div style={{ padding: '10px 12px', borderTop: form.lines.length ? '1px solid var(--border)' : 'none' }}>
                <button
                  type="button"
                  onClick={() => change({ ...form, lines: [...form.lines, { description: '', cents: null, accountId: null, picked: false }] })}
                  style={{ ...linkStyle, background: 'none', border: 'none', padding: 0, fontSize: '14px', cursor: 'pointer', textDecoration: 'underline' }}
                >
                  + Add a line
                </button>
              </div>
            </div>

            {view?.stop ? (
              <div style={{ border: `1px solid ${RED}88`, borderRadius: '12px', padding: '14px', marginTop: '14px' }}>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap', justifyContent: 'space-between' }}>
                  <span style={{ display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <span style={chip(RED)}>Already in NetSuite</span>
                    <span style={{ fontSize: '15px', fontWeight: 800 }}>{form.vendorName}</span>
                  </span>
                  {view.stop.cents !== null && <span style={{ fontSize: '15px', fontWeight: 800 }}>{fmt(view.stop.cents)}</span>}
                </div>
                <div style={{ fontSize: '14px', color: 'var(--text-secondary)', marginTop: '8px' }}>{view.stop.text}</div>
                {view.stop.url && (
                  <a href={view.stop.url} target="_blank" rel="noreferrer" style={{ ...linkStyle, fontSize: '14px', display: 'inline-block', marginTop: '8px' }}>
                    Bill {view.stop.number ?? form.billNumber} in NetSuite ↗
                  </a>
                )}
                {bill.sendUnfinished && (
                  <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '8px' }}>
                    This bill&apos;s last Send didn&apos;t finish. If NetSuite&apos;s bill is the one it sent, mark it sent: Books keeps its own copy, and
                    nothing more goes into NetSuite.
                  </div>
                )}
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'flex-end', marginTop: '10px' }}>
                  {bill.sendUnfinished
                    ? <button type="button" disabled={!!busy} onClick={() => act('mark_sent')} style={bigButton('go', !!busy)}>{busy === 'mark' ? 'Marking it sent…' : 'Mark it sent'}</button>
                    : <button type="button" disabled style={bigButton('go', true)}>Send to NetSuite</button>}
                  <button type="button" disabled={!!busy} onClick={() => setConfirmThrow(true)} style={bigButton()}>Throw it away</button>
                </div>
              </div>
            ) : (
              <>
                <div style={{ marginTop: '12px' }}>
                  {(view?.notes ?? []).map((n, i) => (
                    <div key={i} style={{ fontSize: '13px', color: TONE[n.tone], marginTop: '6px' }}>
                      {n.text}
                      {n.link && <>{' '}<a href={n.link.url} target="_blank" rel="noreferrer" style={{ color: TONE[n.tone] }}>{n.link.label} ↗</a></>}
                    </div>
                  ))}
                  {checking && <div style={{ ...noteText(), marginTop: '6px' }}>Checking…</div>}
                </div>
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '14px' }}>
                  <button
                    type="button"
                    disabled={!view?.canSend || checking || !!busy || stage !== 'idle'}
                    onClick={() => act('send')}
                    style={bigButton('go', !view?.canSend || checking || !!busy || stage !== 'idle')}
                  >
                    {busy === 'send' ? 'Sending…' : 'Send to NetSuite'}
                  </button>
                  <button type="button" disabled={!!busy || stage !== 'idle'} onClick={() => act('save')} style={bigButton()}>
                    {busy === 'save' ? 'Saving…' : 'Save for later'}
                  </button>
                  <button type="button" disabled={!!busy || stage !== 'idle'} onClick={() => setConfirmThrow(true)} style={bigButton()}>Throw it away</button>
                </div>
              </>
            )}

            {confirmThrow && (
              <div style={{ marginTop: '12px', padding: '12px', borderRadius: '10px', border: `1px solid ${RED}55` }}>
                <div style={{ fontSize: '13px', fontWeight: 700 }}>Throw this bill away? Nothing goes into NetSuite. Its picture is kept, marked thrown away.</div>
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '10px' }}>
                  <button type="button" disabled={!!busy} onClick={() => act('throw_away')} style={{ ...bigButton(), color: RED, borderColor: `${RED}88` }}>
                    {busy === 'throw' ? 'Throwing it away…' : 'Yes, throw it away'}
                  </button>
                  <button type="button" disabled={!!busy} onClick={() => setConfirmThrow(false)} style={bigButton()}>Keep it</button>
                </div>
              </div>
            )}
          </fieldset>
        </div>
      )}

      {bill && bill.fileType !== 'application/pdf' && (
        <PhotoLightbox
          photos={[{ id: bill.id, url: deepLinks.booksSnapBillFile(bill.id), title: bill.form.vendorName ?? 'The bill', subtitle: bill.fileName }]}
          index={lightbox ? 0 : null}
          onClose={() => setLightbox(false)}
          onIndex={() => {}}
          printHeading="Snap a bill"
        />
      )}
    </div>
  );
}
