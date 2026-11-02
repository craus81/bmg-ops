'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { booksAccess, booksAllows } from '@/lib/books/access';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import { saveFile } from '@/lib/native-files';
import { fetchCompanyLetterhead } from '@/lib/company-profile';
import { LEGAL } from '@/lib/legal';
import type { Year1099 } from '@/lib/books/1099s';
import {
  checkTin, due1099, fileProblems, fillChoices, fillFromKey, fillKey, FORM_TITLE, FORMS, FORMS_PER_FILE, formName, makeFiles,
  matchTins, maskedTin, NO_FORMS_READY, payerProblems, previewColumn, readHeadings, readTaxIdFile, readTemplateFile, readTin, TIN_TYPES,
  tinTypeOf,
  type ColumnFill, type DueForm, type FileRow, type Form1099, type MadeFile, type Payer, type PayeeDetails, type Template, type Tin,
  type TinType,
} from '@/lib/books/1099-filing';

/**
 * Books → 1099s → File the 1099s (part 70, no migration,
 * src/lib/books/1099-filing.ts, docs/books.md "Filing the 1099s"; the
 * NetSuite Exit Checklist's "1099s and e-filing", thread "Replacing NetSuite
 * with FleetSuite", 2026-10-31).
 *
 * Who gets which 1099 for one company's year under its minimums, from part
 * 50's totals; each one's name and billing address read live from NetSuite
 * (Check them in NetSuite); and the IRS's own CSV template for IRIS, its
 * e-file portal, filled in with them on this device, a file for each form.
 *
 * Tax IDs stay on the device: the payer's is typed here, and a payee's typed
 * here or read here from a NetSuite export dropped on the page, each held
 * against the four digits NetSuite has it ending with. They go only into the
 * file saved here: never in a request, never kept, shown only as they're
 * typed. FleetSuite is told a file was made, with counts only. Nothing is
 * sent to the IRS. The bookkeeper and super admins make the file; the CPA
 * sees who gets one.
 */

interface Payload extends Year1099 {
  companies: Array<{ code: string; name: string }>;
  company: string;
  year: number;
  years: number[];
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencySign: 'accounting' });
const fmt = (cents: number) => money.format(cents / 100);
const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

const GREEN = '#22c55e';
const RED = '#ef4444';
const AMBER = '#fbbf24';

const banner = (color: string): React.CSSProperties => ({
  padding: '10px 14px', borderRadius: '8px', marginBottom: '10px', fontSize: '12px', fontWeight: 600,
  background: `${color}10`, border: `1px solid ${color}40`, color,
});

const button = (active: boolean): React.CSSProperties => ({
  padding: '6px 12px', borderRadius: '8px', border: `1px solid ${active ? 'var(--text-primary)' : 'var(--border)'}`,
  background: 'var(--card)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: active ? 800 : 600, cursor: 'pointer',
});

const act = (color: string | null, enabled: boolean): React.CSSProperties => ({
  padding: '7px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 800,
  border: color ? 'none' : '1px solid var(--border)', background: color ?? 'var(--card)', color: color ? '#fff' : 'var(--text-primary)',
  cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.5,
});

const linkButton: React.CSSProperties = {
  padding: 0, border: 'none', background: 'none', color: 'var(--text-secondary)', fontSize: '11px', fontWeight: 600,
  cursor: 'pointer', textDecoration: 'underline',
};

// 16px so a phone doesn't zoom in on them.
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: '8px', border: '1px solid var(--border)',
  background: 'var(--card)', color: 'var(--text-primary)', fontSize: '16px',
};
const select: React.CSSProperties = { ...input, width: 'auto', maxWidth: '100%', padding: '6px 8px' };

const note: React.CSSProperties = { fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' };
const muted: React.CSSProperties = { fontSize: '11px', color: 'var(--text-muted)', overflowWrap: 'anywhere' };
const label: React.CSSProperties = { display: 'block', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '2px' };
const section: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--card)', marginBottom: '10px' };
const box: React.CSSProperties = { ...section, padding: '10px 14px' };
const summary: React.CSSProperties = { padding: '10px 14px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' };
const heading: React.CSSProperties = { fontSize: '14px', fontWeight: 800, marginBottom: '4px' };
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px', marginTop: '8px' };
const redLines: React.CSSProperties = { fontSize: '12px', color: RED, display: 'grid', gap: '2px', marginTop: '6px' };

const BLANK_PAYER: Payer = { name: '', name2: '', address1: '', address2: '', city: '', state: '', zip: '', phone: '', email: '', tin: '' };

/** A tax ID as text that reads back the same, so how it was written (12-3456789, an EIN) carries over. */
const tinText = (t: Tin) => (t.looks === 'EIN' ? `${t.digits.slice(0, 2)}-${t.digits.slice(2)}`
  : t.looks ? `${t.digits.slice(0, 3)}-${t.digits.slice(3, 5)}-${t.digits.slice(5)}` : t.digits);

/** A form's boxes in words: 1099-NEC box 1 $12,000.00. */
const boxesText = (f: DueForm) =>
  `${FORM_TITLE[f.form]} ${Object.entries(f.boxes).sort(([a], [b]) => Number(a) - Number(b)).map(([b, c]) => `box ${b} ${fmt(c)}`).join(', ')}`;

/** One payee getting a 1099, with what's known of it on this page. */
interface PayeeState {
  payee: string;
  name: string;
  forms: DueForm[];
  total: number;
  details: PayeeDetails | null;
  failed: string | null;
  /** Its tax ID as typed, or as read from an export. */
  raw: string;
  fromFile: boolean;
  tin: Tin | null;
  tinType: TinType;
  check: { ok: boolean; why: string };
  /** Why it can't go in the file yet; null when it's ready. */
  why: string | null;
}

/** A file made for a form, held here (it has tax IDs) until it's saved. */
interface Made {
  files: MadeFile[];
  saved: string[];
  leftOut: Array<{ payee: string; name: string; why: string }>;
  /** How many times it's been made on this page. */
  times: number;
  /** Every payee in a file made for the form on this page. */
  payees: string[];
}

interface FormState {
  template: Template | null;
  fills: ColumnFill[];
  problems: string[];
  error: string;
  dashes: boolean;
  /** Leave out the forms in a file made before. */
  onlyNew: boolean;
  made: Made | null;
  makeError: string;
}

const blankForm = (): FormState => ({ template: null, fills: [], problems: [], error: '', dashes: false, onlyNew: true, made: null, makeError: '' });
const blankForms = (): Record<Form1099, FormState> => ({ NEC: blankForm(), MISC: blankForm() });

/** A box to drop a file on, or tap to choose one. */
function FileDrop({ accept, title, about, busy, onFile }: {
  accept: string;
  title: string;
  about: React.ReactNode;
  busy: boolean;
  onFile: (f: File | undefined) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept={accept}
        disabled={busy}
        style={{ display: 'none' }}
        onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }}
      />
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (!busy) onFile(e.dataTransfer.files?.[0]); }}
        onClick={() => !busy && ref.current?.click()}
        style={{
          border: `2px dashed ${dragging ? GREEN : 'var(--border)'}`, borderRadius: '8px', padding: '12px', cursor: busy ? 'default' : 'pointer',
          background: dragging ? `${GREEN}10` : 'transparent', fontSize: '12px', color: 'var(--text-secondary)', marginTop: '8px',
        }}
      >
        <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
        <div style={{ marginTop: '2px' }}>{about}</div>
      </div>
    </>
  );
}

/** One payee: its forms and boxes, its name and address as NetSuite has them, and its tax ID. */
function PayeeCard({ s, canKeep, onTin, onType, onTypeIt }: {
  s: PayeeState;
  canKeep: boolean;
  onTin: (raw: string) => void;
  onType: (t: TinType) => void;
  onTypeIt: () => void;
}) {
  const d = s.details;
  const zip = d && d.zip.length === 9 ? `${d.zip.slice(0, 5)}-${d.zip.slice(5)}` : d?.zip;
  const address = d ? [d.address1, d.address2, [d.city, d.state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') : '';
  const digits = s.raw.replace(/\D/g, '').length;
  // While it's being typed, say what it takes; once it's nine digits or more, whether it's one.
  const tinLine = !s.raw.trim() ? { text: 'No tax ID yet.', color: 'var(--text-muted)' }
    : !s.tin ? (digits < 9
      ? { text: 'Nine digits, as 12-3456789 or 123-45-6789.', color: 'var(--text-muted)' }
      : { text: "That isn't a tax ID: nine digits, as 12-3456789 or 123-45-6789.", color: RED })
      : { text: s.check.why, color: s.check.ok ? GREEN : RED };
  return (
    <div style={{ padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
        <span>
          <span style={{ fontWeight: 700 }}>{s.name}</span>
          {canKeep && !s.why && <span style={{ ...muted, color: GREEN, fontWeight: 700, marginLeft: '6px' }}>Ready</span>}
        </span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(s.total)}</span>
      </div>
      <div style={muted}>{s.forms.map(boxesText).join(' · ')}</div>
      {d && (
        <div style={muted}>
          On the form as {formName(d) || '(no name)'}{d.business2 ? `, doing business as ${d.business2}` : ''}{d.person ? ', a person' : ''}
          {address ? ` · ${address}` : ''}
        </div>
      )}
      {s.failed && <div style={{ ...muted, color: RED }}>NetSuite wouldn&apos;t give its vendor record: {s.failed}</div>}
      {d?.problems.map((p) => <div key={p} style={{ ...muted, color: RED }}>{p}</div>)}
      {d?.notes.map((n) => <div key={n} style={muted}>{n}</div>)}
      {canKeep && (
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', marginTop: '6px' }}>
          {s.fromFile && s.tin ? (
            <span style={{ fontSize: '12px', fontWeight: 700 }}>
              Tax ID {maskedTin(s.tin.digits)}, from the export{' '}
              <button style={linkButton} onClick={onTypeIt}>Type it instead</button>
            </span>
          ) : (
            <input
              aria-label={`${s.name}'s tax ID`}
              style={{ ...input, width: '180px' }}
              value={s.raw}
              placeholder="Tax ID"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => onTin(e.target.value)}
            />
          )}
          <select aria-label={`${s.name}'s tax ID type`} style={select} value={s.tinType} onChange={(e) => onType(e.target.value as TinType)}>
            {TIN_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <span style={{ ...muted, color: tinLine.color, fontWeight: 600 }}>{tinLine.text}</span>
        </div>
      )}
    </div>
  );
}

export default function File1099sPage() {
  const router = useRouter();
  const { hasRole, hasFeature, canSeeMoney, loading: authLoading } = useAuth();
  // The bookkeeper and super admins check them in NetSuite and make the file; the CPA sees who gets one.
  const canKeep = booksAllows(booksAccess(hasRole), 'keep');
  // Vendor Details is a Payments page (src/app/(main)/admin/vendor-details), where a name, address or tax ID is fixed.
  const canVendorDetails = hasFeature('vendor_payments') && canSeeMoney;
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [introOpen, setIntroOpen] = useState(false);

  const [details, setDetails] = useState<Record<string, PayeeDetails>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [checking, setChecking] = useState<{ done: number; of: number } | null>(null);
  const [checkError, setCheckError] = useState('');
  const [tins, setTins] = useState<Record<string, { raw: string; fromFile: boolean }>>({});
  const [tinTypes, setTinTypes] = useState<Record<string, TinType>>({});
  const [tinFile, setTinFile] = useState<{ name: string; column: string | null; found: number; twice: string[]; unmatched: number; padded: number; unreadable: number } | null>(null);
  const [tinBusy, setTinBusy] = useState(false);
  const [tinProblems, setTinProblems] = useState<string[]>([]);
  const [payer, setPayer] = useState<Payer>(BLANK_PAYER);
  const [forms, setForms] = useState<Record<Form1099, FormState>>(blankForms);
  // Bumped when the company or year changes, so a check still going for the one before stops.
  const generation = useRef(0);

  const load = useCallback(async (company: string, year: string) => {
    try {
      const params = new URLSearchParams();
      if (company) params.set('company', company);
      if (year) params.set('year', year);
      const res = await apiFetch(`/api/admin/books/1099s?${params}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setError('');
      // Keep the address on what's shown, so going back here opens it again.
      window.history.replaceState(null, '', deepLinks.books1099Filing(json.company, json.year));
    } catch (e: any) {
      setError(e?.message || "Could not load the year's 1099s");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!booksAccess(hasRole)) { router.push('/home'); return; }
    const q = new URLSearchParams(window.location.search);
    load(q.get('company') ?? '', q.get('year') ?? '');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  // BMG's legal name and letterhead address to start the payer with; anything typed stays.
  const company = data?.company;
  useEffect(() => {
    if (company !== 'BMG') return;
    let live = true;
    fetchCompanyLetterhead().then((l) => {
      if (!live) return;
      const c = l?.company;
      setPayer((p) => ({
        ...p,
        name: p.name || LEGAL.entityName,
        address1: p.address1 || c?.address || '',
        city: p.city || c?.city || '',
        state: p.state || c?.state || '',
        zip: p.zip || c?.zip || '',
        phone: p.phone || c?.phone || '',
        email: p.email || c?.email || '',
      }));
    });
    return () => { live = false; };
  }, [company]);

  // Everything typed or read for one company's year goes when another is picked.
  const pick = (code: string, year: number) => {
    if (!data) return;
    generation.current++;
    setLoading(true);
    setDetails({});
    setFailed({});
    setChecking(null);
    setCheckError('');
    setTins({});
    setTinTypes({});
    setTinFile(null);
    setTinProblems([]);
    setForms(blankForms());
    if (code !== data.company) setPayer(BLANK_PAYER);
    load(code, String(year));
  };

  const due = useMemo(() => (data ? due1099(data, data.year, { yearOver: data.year < data.years[0] }) : null), [data]);

  const payees = useMemo((): PayeeState[] => {
    if (!due) return [];
    const by = new Map<string, PayeeState>();
    for (const f of due.forms) {
      const seen = by.get(f.payee);
      if (seen) {
        seen.forms.push(f);
        seen.total += f.total;
        continue;
      }
      const d = details[f.payee] ?? null;
      const entry = tins[f.payee];
      const raw = entry?.raw ?? '';
      const tin = readTin(raw);
      const check = checkTin(tin, d);
      const why = failed[f.payee] ? `NetSuite wouldn't give its vendor record: ${failed[f.payee]}`
        : !d ? 'Not checked in NetSuite yet.'
          : d.problems.length ? d.problems.join(' ')
            : !raw.trim() ? 'No tax ID yet.'
              : !tin ? "Its tax ID isn't nine digits."
                : !check.ok ? check.why : null;
      by.set(f.payee, {
        payee: f.payee,
        name: f.name,
        forms: [f],
        total: f.total,
        details: d,
        failed: failed[f.payee] ?? null,
        raw,
        fromFile: !!entry?.fromFile,
        tin,
        tinType: tinTypes[f.payee] ?? (tin ? tinTypeOf(tin, d?.person ?? false) : d?.person ? 'SSN' : 'EIN'),
        check,
        why,
      });
    }
    return [...by.values()].sort((a, b) => a.name.localeCompare(b.name, 'en-US'));
  }, [due, details, failed, tins, tinTypes]);

  const byPayee = useMemo(() => new Map(payees.map((p) => [p.payee, p])), [payees]);

  /**
   * A form's rows for the file, those not ready (left out of it), how many
   * were in a file made before, and the first ready one, in a file before or
   * not, to show the columns with.
   */
  const formRows = (form: Form1099) => {
    const st = forms[form];
    const before = new Set(st.made?.payees ?? []);
    const rows: FileRow[] = [];
    const leftOut: Made['leftOut'] = [];
    let madeBefore = 0;
    let first: FileRow | null = null;
    for (const f of due?.forms ?? []) {
      if (f.form !== form) continue;
      const s = byPayee.get(f.payee);
      if (!s) continue;
      const row = !s.why && s.details && s.tin ? { form: f, details: s.details, tin: s.tin, tinType: s.tinType } : null;
      first ??= row;
      if (before.has(f.payee)) {
        madeBefore++;
        if (st.onlyNew) continue;
      }
      if (row) rows.push(row);
      else leftOut.push({ payee: f.payee, name: f.name, why: s.why ?? 'Not ready.' });
    }
    return { rows, leftOut, madeBefore, first };
  };

  const updateForm = (form: Form1099, patch: (s: FormState) => Partial<FormState>) =>
    setForms((prev) => ({ ...prev, [form]: { ...prev[form], ...patch(prev[form]) } }));

  // Each vendor getting a 1099 read live from NetSuite, 25 at a time: its name and address, never its tax ID.
  const checkInNetSuite = async () => {
    if (!data || !due || checking) return;
    const at = generation.current;
    const ids = [...new Set(due.forms.map((f) => f.payee))];
    setCheckError('');
    setChecking({ done: 0, of: ids.length });
    try {
      for (let i = 0; i < ids.length; i += 25) {
        const batch = ids.slice(i, i + 25);
        const res = await apiFetch('/api/admin/books/1099s', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ company: data.company, year: data.year, payees: batch }),
        });
        const json = await res.json().catch(() => ({}));
        if (generation.current !== at) return;
        if (!res.ok) throw new Error(json.error || `Couldn't check them in NetSuite (${res.status})`);
        const read = (json.details ?? []) as PayeeDetails[];
        const wouldnt = (json.failed ?? []) as Array<{ payee: string; error: string }>;
        setDetails((prev) => {
          const next = { ...prev };
          for (const d of read) next[d.payee] = d;
          for (const f of wouldnt) delete next[f.payee];
          return next;
        });
        setFailed((prev) => {
          const next = { ...prev };
          for (const d of read) delete next[d.payee];
          for (const f of wouldnt) next[f.payee] = f.error;
          return next;
        });
        setChecking({ done: i + batch.length, of: ids.length });
      }
    } catch (e: any) {
      setCheckError(e?.message || "Couldn't check them in NetSuite");
    } finally {
      if (generation.current === at) setChecking(null);
    }
  };

  // A NetSuite export with tax IDs, read here: each one found goes in for its payee, and nothing is sent.
  const readTins = async (file: File | undefined) => {
    if (!file || !data || !due || tinBusy) return;
    const at = generation.current;
    setTinProblems([]);
    setTinBusy(true);
    try {
      const read = await readTaxIdFile(file);
      if (generation.current !== at) return;
      if (read.problems.length) {
        setTinProblems(read.problems);
        return;
      }
      const found = matchTins(read, data, new Set(due.forms.map((f) => f.payee)));
      setTins((prev) => {
        const next = { ...prev };
        for (const [p, tin] of found.byPayee) next[p] = { raw: tinText(tin), fromFile: true };
        return next;
      });
      const name = (p: string) => due.forms.find((f) => f.payee === p)?.name ?? p;
      setTinFile({
        name: file.name, column: read.column, found: found.byPayee.size, twice: found.twice.map(name),
        unmatched: found.unmatched, padded: read.padded, unreadable: read.unreadable,
      });
    } catch (e: any) {
      if (generation.current === at) setTinProblems([e?.message || "Couldn't read that file"]);
    } finally {
      if (generation.current === at) setTinBusy(false);
    }
  };

  const readTemplateFor = async (form: Form1099, file: File | undefined) => {
    if (!file) return;
    const at = generation.current;
    updateForm(form, () => ({ problems: [], error: '' }));
    try {
      const r = await readTemplateFile(file);
      if (generation.current !== at) return;
      if (!r.template) {
        updateForm(form, () => ({ problems: r.problems }));
        return;
      }
      const template = r.template;
      updateForm(form, () => ({ template, fills: readHeadings(template.headings, form), makeError: '' }));
    } catch (e: any) {
      if (generation.current === at) updateForm(form, () => ({ error: e?.message || "Couldn't read that file" }));
    }
  };

  const setFill = (form: Form1099, i: number, f: ColumnFill) =>
    updateForm(form, (s) => ({ fills: s.fills.map((x, j) => (j === i ? f : x)) }));

  const save = (form: Form1099, f: MadeFile) => {
    saveFile(new Blob([f.text], { type: 'text/csv' }), f.name)
      .then(() => updateForm(form, (s) => (s.made ? { made: { ...s.made, saved: [...new Set([...s.made.saved, f.name])] } } : {})))
      .catch((e: any) => updateForm(form, () => ({ makeError: e?.message || "Couldn't save the file" })));
  };

  // Made here and saved here, in the same tap: the share sheet in the app needs it.
  const make = (form: Form1099) => {
    const st = forms[form];
    if (!data || !due || !st.template || !canKeep || due.blockers.length) return;
    const { rows, leftOut } = formRows(form);
    const times = (st.made?.times ?? 0) + 1;
    const base = `${data.year}-1099-${form}-${data.company}${times > 1 ? `-${times}` : ''}`;
    const out = makeFiles(st.template, st.fills, form, data.year, payer, rows, { dashes: st.dashes }, base);
    if (out.problems.length) {
      updateForm(form, () => ({ makeError: out.problems.join(' ') }));
      return;
    }
    updateForm(form, (s) => ({
      makeError: '',
      made: {
        files: out.files, saved: [], leftOut, times,
        payees: [...new Set([...(s.made?.payees ?? []), ...rows.map((r) => r.form.payee)])],
      },
    }));
    // More than one file is saved a tap each, as a phone shares one at a time.
    if (out.files.length === 1) save(form, out.files[0]);
    // That it was made, with counts only.
    apiFetch('/api/admin/books/1099s', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        company: data.company, year: data.year,
        madeFile: { form, forms: rows.length, files: out.files.length, leftOut: leftOut.length },
      }),
    }).catch(() => {});
  };

  const companyName = data?.companies.find((c) => c.code === data.company)?.name ?? data?.company;
  const ready = payees.filter((p) => !p.why).length;
  const notChecked = payees.filter((p) => !p.details && !p.failed).length;
  const toFix = payees.filter((p) => p.failed || (p.details && p.details.problems.length)).length;
  const noTin = payees.filter((p) => p.details && !p.details.problems.length && !p.check.ok).length;
  const checkedAny = payees.some((p) => p.details || p.failed);
  const payerColumns = FORMS.some((f) => forms[f].fills.some((x) => x.kind === 'party' && x.party === 'payer'));
  const payerSays = payerProblems(payer);

  const setPayerField = (k: keyof Payer) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setPayer((p) => ({ ...p, [k]: v }));
  };
  const payerInput = (k: keyof Payer, title: string, extra?: React.InputHTMLAttributes<HTMLInputElement>, wide?: boolean) => (
    <label style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <span style={label}>{title}</span>
      <input style={input} value={payer[k]} onChange={setPayerField(k)} autoComplete="off" spellCheck={false} {...extra} />
    </label>
  );

  const formSection = (form: Form1099) => {
    const st = forms[form];
    const title = FORM_TITLE[form];
    const { rows, leftOut, madeBefore, first } = formRows(form);
    const t = st.template;
    const problems = t ? fileProblems(t, st.fills, form, payer, rows) : [];
    // None ready is said by the count under them.
    const shown = rows.length ? problems : problems.filter((p) => p !== NO_FORMS_READY);
    const unread = st.fills.filter((f) => f.kind === 'blank' && !f.read).length;
    const choices = fillChoices(form);
    const blocked = !!due?.blockers.length;
    const canMake = canKeep && !!t && !blocked && !problems.length;
    return (
      <div key={form} style={box}>
        <div style={heading}>Make the {title} file</div>
        <div style={muted}>
          {count(due?.counts[form] ?? 0, `payee gets a ${title}`, `payees get a ${title}`)} for {data?.year}.
          {' '}Up to {FORMS_PER_FILE} forms go in a file, within what IRIS takes, so more make more than one file.
        </div>

        <FileDrop
          accept=".csv,text/csv"
          busy={false}
          title={t ? `${t.name} · ${count(t.headings.length, 'column', 'columns')}. Drop another, or tap to choose it` : `Drop the IRS's ${title} template here, or tap to choose it`}
          about={t ? 'The file has its headings exactly as they are.' : (
            <>In IRIS, download the CSV template for the {title} for {data?.year} (Upload CSV with form data), and drop it here as it came.
              FleetSuite fills it in on this device and saves the file here.</>
          )}
          onFile={(f) => readTemplateFor(form, f)}
        />
        {st.error && <div style={{ ...redLines, fontWeight: 700 }}>{st.error}</div>}
        {st.problems.length > 0 && <div style={redLines}>{st.problems.map((p) => <div key={p}>{p}</div>)}</div>}

        {t && (
          <details style={{ ...section, marginTop: '8px', marginBottom: 0 }}>
            <summary style={{ ...summary, fontSize: '12px' }}>
              Columns ({t.headings.length}){unread ? `: FleetSuite can't tell what ${count(unread, 'is', 'are')}` : ''}
            </summary>
            <div style={{ padding: '0 14px 10px' }}>
              <label style={{ display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', margin: '4px 0 8px' }}>
                <input type="checkbox" checked={st.dashes} onChange={(e) => { const v = e.target.checked; updateForm(form, () => ({ dashes: v })); }} />
                Tax IDs and ZIP+4s with their dashes (12-3456789, 63366-1234)
              </label>
              {t.headings.map((h, i) => {
                const f: ColumnFill = st.fills[i] ?? { kind: 'blank', read: false };
                const preview = previewColumn(f, first, t, st.fills, form, data?.year ?? 0, payer, { dashes: st.dashes });
                return (
                  <div key={`${i}-${h}`} style={{ padding: '6px 0', borderTop: '1px solid var(--border)', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '4px' }}>
                    <div style={{ fontSize: '12px', fontWeight: 700 }}>{h || `Column ${i + 1}`}</div>
                    <select aria-label={`What goes under ${h || `column ${i + 1}`}`} style={{ ...select, width: '100%' }} value={fillKey(f)} onChange={(e) => setFill(form, i, fillFromKey(e.target.value))}>
                      {choices.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                    </select>
                    {f.kind === 'same' && (
                      <input
                        aria-label={`What goes under ${h || `column ${i + 1}`} in every row`}
                        style={input}
                        value={f.value}
                        placeholder="What goes in every row"
                        autoComplete="off"
                        onChange={(e) => setFill(form, i, { kind: 'same', value: e.target.value })}
                      />
                    )}
                    {f.kind === 'blank' && !f.read && (
                      <div style={{ ...muted, color: AMBER, fontWeight: 600 }}>FleetSuite can&apos;t tell what this is, so it&apos;s left blank. Pick it if it should have something.</div>
                    )}
                    <div style={muted}>{first ? `${first.form.name}: ` : 'Each form: '}{preview || '(blank)'}</div>
                  </div>
                );
              })}
            </div>
          </details>
        )}

        {t && shown.length > 0 && <div style={redLines}>{shown.map((p) => <div key={p}>{p}</div>)}</div>}

        {t && (
          <div style={{ fontSize: '12px', marginTop: '8px' }}>
            <div style={{ fontWeight: 700, color: rows.length ? GREEN : 'var(--text-muted)' }}>
              {count(rows.length, `${title} is`, `${title}s are`)} ready to go in the file.
            </div>
            {madeBefore > 0 && (
              <label style={{ display: 'flex', gap: '6px', alignItems: 'center', margin: '4px 0' }}>
                <input type="checkbox" checked={st.onlyNew} onChange={(e) => { const v = e.target.checked; updateForm(form, () => ({ onlyNew: v })); }} />
                Leave out the {count(madeBefore, 'form', 'forms')} in a file made before
              </label>
            )}
            {leftOut.length > 0 && (
              <details style={{ marginTop: '4px' }}>
                <summary style={{ cursor: 'pointer', color: RED, fontWeight: 700 }}>
                  {count(leftOut.length, "isn't", "aren't")} ready, and {leftOut.length === 1 ? 'is' : 'are'} left out of the file until {leftOut.length === 1 ? 'it is' : 'they are'}
                </summary>
                {leftOut.map((l) => (
                  <div key={l.payee} style={{ ...muted, padding: '4px 0', borderTop: '1px solid var(--border)' }}>
                    <span style={{ fontWeight: 700, color: 'var(--text-secondary)' }}>{l.name}</span>: {l.why}
                  </div>
                ))}
              </details>
            )}
          </div>
        )}

        {canKeep && t && (
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '10px' }}>
            <button style={act(GREEN, canMake)} disabled={!canMake} onClick={() => make(form)}>
              {st.made ? `Make the ${title} file again` : `Make the ${title} file`}
            </button>
            {blocked && <span style={{ ...muted, color: AMBER, fontWeight: 600 }}>Not until what&apos;s at the top is sorted out.</span>}
          </div>
        )}
        {st.makeError && <div style={{ ...redLines, fontWeight: 700 }}>{st.makeError}</div>}

        {st.made && (
          <div style={{ fontSize: '12px', marginTop: '8px', display: 'grid', gap: '4px' }}>
            {st.made.files.map((f) => {
              const saved = st.made!.saved.includes(f.name);
              return (
                <div key={f.name} style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, color: saved ? GREEN : 'var(--text-primary)' }}>
                    {saved ? 'Saved' : 'Made'} {f.name}, {count(f.forms, 'form', 'forms')}
                  </span>
                  <button style={act(saved ? null : GREEN, true)} onClick={() => save(form, f)}>{saved ? 'Save again' : 'Save'}</button>
                </div>
              );
            })}
            <div style={muted}>
              Upload {st.made.files.length === 1 ? 'it' : 'each one'} in IRIS (Upload CSV with form data), check every form IRIS shows, then
              submit.{st.made.leftOut.length ? ` The ${count(st.made.leftOut.length, "form that wasn't ready isn't", "forms that weren't ready aren't")} in it: once ${st.made.leftOut.length === 1 ? 'it is' : 'they are'}, make the file again, and it leaves out the ones already in a file.` : ''}
              {' '}This page remembers which forms were in a file only until it&apos;s closed or reloaded.
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>File the 1099s</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          {/* Two lines until More opens the rest below them. */}
          <div style={introOpen ? undefined : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            Who gets a 1099 for the year under its minimums, from the 1099s page&apos;s totals, each one&apos;s name and address read from
            NetSuite as they are now, and the IRS&apos;s own upload template for IRIS, its e-file portal, filled in with them on this device.
            Tax IDs are typed here, or read here from a NetSuite export, and go only into the file saved on this device: FleetSuite never
            gets them, beyond the four digits NetSuite has each one ending with. Nothing is sent to the IRS: the file is uploaded in IRIS,
            where each form is checked before it&apos;s submitted.
          </div>
          <button
            onClick={() => setIntroOpen(!introOpen)}
            style={{ padding: 0, border: 'none', background: 'none', color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}
          >
            {introOpen ? 'Less' : 'More'}
          </button>
          {' · '}
          <Link href={data ? deepLinks.books1099s(data.company, data.year) : '/admin/books/1099s'} style={{ color: 'var(--text-secondary)' }}>1099s</Link>
          {canVendorDetails && (
            <>
              {' · '}
              <Link href="/admin/vendor-details" style={{ color: 'var(--text-secondary)' }}>Vendor Details</Link>
            </>
          )}
        </div>
      </div>

      {error && <div style={banner(RED)}>{error}</div>}

      {data && due && (
        <>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
            {data.companies.length > 1 && data.companies.map((c) => (
              <button key={c.code} onClick={() => pick(c.code, data.year)} disabled={loading} style={button(c.code === data.company)}>
                {c.name}
              </button>
            ))}
            {data.companies.length > 1 && <span style={{ width: '8px' }} />}
            {data.years.map((y) => (
              <button key={y} onClick={() => pick(data.company, y)} disabled={loading} style={button(y === data.year)}>{y}</button>
            ))}
          </div>

          {due.blockers.length > 0 && (
            <div style={banner(AMBER)}>
              <div style={{ marginBottom: '2px' }}>No file can be made for {data.year} yet:</div>
              {due.blockers.map((b) => <div key={b} style={{ fontWeight: 500 }}>{b}</div>)}
            </div>
          )}
          {!due.minimum.known && (
            <div style={banner(AMBER)}>
              FleetSuite doesn&apos;t have the IRS&apos;s minimum for {data.year} yet, so it uses {fmt(due.minimum.cents)}, the last one it has. A
              payee paid just under the real one may show as getting a 1099, but none that should get one is left out.
            </div>
          )}

          <div style={note}>
            {due.forms.length
              ? `${companyName}, ${data.year}: ${count(payees.length, 'payee gets', 'payees get')} ${[
                due.counts.NEC ? count(due.counts.NEC, '1099-NEC', '1099-NECs') : '',
                due.counts.MISC ? count(due.counts.MISC, '1099-MISC', '1099-MISCs') : '',
              ].filter(Boolean).join(' and ')}.`
              : `${companyName}, ${data.year}: nobody gets a 1099.`}
            {` A form is due when a box comes to ${fmt(due.minimum.cents)} or more (royalties $10, an attorney's gross proceeds $600), and then has every box paid in.`}
          </div>

          {payees.length > 0 && (
            <div style={box}>
              <div style={heading}>Who gets one</div>
              {canKeep && (
                <>
                  <div style={muted}>
                    Check them in NetSuite to read each one&apos;s name and billing address as they go on the form, then put in each tax ID: type it, or
                    drop a NetSuite export with them.
                  </div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '8px' }}>
                    <button style={act(null, !checking)} disabled={!!checking} onClick={checkInNetSuite}>
                      {checkedAny ? 'Check them in NetSuite again' : 'Check them in NetSuite'}
                    </button>
                    {checking && <span style={muted}>Reading {checking.done.toLocaleString('en-US')} of {checking.of.toLocaleString('en-US')} from NetSuite…</span>}
                  </div>
                  {checkError && <div style={{ ...redLines, fontWeight: 700 }}>{checkError}</div>}
                  <div style={{ fontSize: '12px', fontWeight: 700, marginTop: '8px' }}>
                    <span style={{ color: ready ? GREEN : 'var(--text-muted)' }}>{ready.toLocaleString('en-US')} of {payees.length.toLocaleString('en-US')} ready</span>
                    {notChecked > 0 && <span style={{ color: 'var(--text-muted)' }}> · {notChecked.toLocaleString('en-US')} not checked in NetSuite yet</span>}
                    {toFix > 0 && <span style={{ color: RED }}> · {count(toFix, 'to fix in NetSuite', 'to fix in NetSuite')}</span>}
                    {noTin > 0 && <span style={{ color: AMBER }}> · {count(noTin, 'tax ID', 'tax IDs')} to put in</span>}
                  </div>

                  <FileDrop
                    accept=".csv,.tsv,.txt,.xlsx,text/csv"
                    busy={tinBusy}
                    title="Drop a NetSuite export with the tax IDs here, or tap to choose it"
                    about={(
                      <>
                        NetSuite&apos;s 1099 report, or a vendor search with the Tax ID column, as CSV or Excel .xlsx. It&apos;s read on this device,
                        and its tax IDs go only into the file made here, never to FleetSuite.
                      </>
                    )}
                    onFile={readTins}
                  />
                  {tinBusy && <div style={{ ...muted, marginTop: '4px' }}>Reading the file…</div>}
                  {tinProblems.length > 0 && <div style={redLines}>{tinProblems.map((p) => <div key={p}>{p}</div>)}</div>}
                  {tinFile && (
                    <div style={{ ...muted, marginTop: '4px' }}>
                      {`Read ${count(tinFile.found, 'tax ID', 'tax IDs')} for those getting a 1099 from ${tinFile.name}${tinFile.column ? `, under ${tinFile.column}` : ''}.`}
                      {tinFile.unmatched ? ` ${count(tinFile.unmatched, "row wasn't", "rows weren't")} for anyone getting one, or fit more than one.` : ''}
                      {tinFile.padded ? ` ${count(tinFile.padded, 'had', 'had')} lost a leading 0, as Excel drops them, and got it back.` : ''}
                      {tinFile.unreadable ? ` ${count(tinFile.unreadable, 'was', 'were')} masked or not nine digits, so left out.` : ''}
                      {tinFile.twice.length > 0 && (
                        <span style={{ color: RED }}>{` It has two different ones for ${tinFile.twice.join(', ')}, so neither is used: type it.`}</span>
                      )}
                    </div>
                  )}
                </>
              )}
              {!canKeep && <div style={muted}>The bookkeeper or a super admin checks them in NetSuite and makes the file.</div>}

              <div style={{ marginTop: '8px' }}>
                {payees.map((s) => (
                  <PayeeCard
                    key={s.payee}
                    s={s}
                    canKeep={canKeep}
                    onTin={(raw) => setTins((prev) => ({ ...prev, [s.payee]: { raw, fromFile: false } }))}
                    onType={(t) => setTinTypes((prev) => ({ ...prev, [s.payee]: t }))}
                    onTypeIt={() => setTins((prev) => ({ ...prev, [s.payee]: { raw: '', fromFile: false } }))}
                  />
                ))}
              </div>
            </div>
          )}

          {due.byHand.length > 0 && (
            <details style={section} open>
              <summary style={{ ...summary, color: RED }}>To file by hand in IRIS ({due.byHand.length.toLocaleString('en-US')})</summary>
              <div style={{ ...note, padding: '0 14px' }}>
                Each is marked to get a 1099 and was paid on accounts that count toward one, but FleetSuite doesn&apos;t make its form.
              </div>
              <div style={{ padding: '0 14px 8px' }}>
                {due.byHand.map((h) => (
                  <div key={h.payee} style={{ padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
                      <span style={{ fontWeight: 700 }}>{h.name}</span>
                      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(h.total)}</span>
                    </div>
                    <div style={{ ...muted, color: RED }}>{h.why}</div>
                  </div>
                ))}
              </div>
            </details>
          )}

          {due.under.length > 0 && (
            <details style={section}>
              <summary style={summary}>Under the minimums, no 1099 ({due.under.length.toLocaleString('en-US')})</summary>
              <div style={{ padding: '0 14px 8px' }}>
                {due.under.map((u) => (
                  <div key={`${u.form}-${u.payee}`} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: '12px' }}>
                    <span>
                      <span style={{ fontWeight: 700 }}>{u.name}</span>
                      <span style={{ ...muted, marginLeft: '6px' }}>{FORM_TITLE[u.form]}</span>
                    </span>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(u.total)}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          {data.notMarked.length > 0 && (
            <div style={note}>
              {count(data.notMarked.length, 'payee was', 'payees were')} paid on accounts that count toward a 1099 without being marked to get
              one, so {data.notMarked.length === 1 ? "isn't" : "aren't"} here: see{' '}
              <Link href={deepLinks.books1099s(data.company, data.year)} style={{ color: 'var(--text-secondary)' }}>the 1099s page</Link>.
            </div>
          )}

          {canKeep && payees.length > 0 && (
            <>
              <div style={box}>
                <div style={heading}>The payer</div>
                <div style={muted}>
                  {companyName} as it goes on every form. The EIN is typed here each time and goes only into the file.
                  {company === 'BMG' ? ' The name and address start from the letterhead.' : ''}
                </div>
                <div style={grid}>
                  {payerInput('name', 'Legal name', undefined, true)}
                  {payerInput('name2', 'Doing business as (if any)', undefined, true)}
                  {payerInput('address1', 'Street', undefined, true)}
                  {payerInput('address2', 'Street, second line', undefined, true)}
                  {payerInput('city', 'City')}
                  {payerInput('state', 'State')}
                  {payerInput('zip', 'ZIP')}
                  {payerInput('phone', 'Phone', { inputMode: 'tel' })}
                  {payerInput('email', 'Email', { inputMode: 'email' }, true)}
                  {payerInput('tin', 'EIN', { inputMode: 'numeric', placeholder: '12-3456789' })}
                </div>
                {payerColumns && payerSays.length > 0 && <div style={redLines}>{payerSays.map((p) => <div key={p}>{p}</div>)}</div>}
                {!payerColumns && <div style={{ ...muted, marginTop: '6px' }}>It goes in the file when the IRS&apos;s template has the payer&apos;s columns.</div>}
              </div>

              {FORMS.filter((f) => due.counts[f] > 0).map(formSection)}
            </>
          )}

          <div style={note}>
            Nothing is sent to the IRS. Upload each file in IRIS, check every form there, then submit; IRIS can give each recipient&apos;s copy to
            print or send. Filing in IRIS takes a Transmitter Control Code (TCC), and applying for one can take up to 45 days.
          </div>
        </>
      )}
      {loading && !error && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '10px' }}>Loading…</div>}
    </div>
  );
}
