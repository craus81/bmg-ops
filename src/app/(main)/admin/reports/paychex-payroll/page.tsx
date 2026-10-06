'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import { downloadCsv } from '@/lib/csv';
import type { PayrollGroup, PayrollReport, PeriodSummary } from '@/lib/paychex-payroll';

/**
 * Paychex Payroll (migration 340, owner ask 2026-10-06): the Paychex Flex
 * "Payroll Labor Cost" report, uploaded each payroll, as labor cost by pay
 * period, month, location, position and person. Three tabs:
 *   Report — the rollups for a date range (by pay period END date).
 *   Upload — preview then save a Paychex CSV; re-uploading a period replaces it.
 *   People — match Paychex employees to FleetSuite people (feeds the pooled
 *            shop labor rate the Vehicle Margin report uses).
 * Super admin / executive only, same wall as the route.
 */

interface Employee { paychex_employee_id: string; employee_name: string; profile_id: string | null; profile_name: string | null; guess_profile_id: string | null }
interface ImportRow { id: string; file_name: string | null; uploaded_at: string; uploaded_by_name: string | null; row_count: number; period_count: number; first_period_start: string | null; last_period_end: string | null; replaced_rows: number }
interface CostBasis { rate: number | null; source: 'paychex' | 'setting' | null; people?: number; throughPeriodEnd?: string }
interface Payload {
  range: { from: string; to: string };
  report: PayrollReport;
  employees: Employee[];
  profiles: { id: string; full_name: string | null }[];
  imports: ImportRow[];
  shopCostBasis: CostBasis;
}
type PreviewPeriod = PeriodSummary & { replaces: number };

const fmtMoney = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmtRate = (n: number | null) => (n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }));
const fmtHrs = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 1 });
const fmtDate = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const fmtMonth = (ym: string) => new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 16px', marginBottom: '14px' };
const eyebrow: React.CSSProperties = { fontSize: '11px', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.7px', marginBottom: '8px' };
const th: React.CSSProperties = { fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)', padding: '6px 8px', borderBottom: '1px solid var(--border)', textAlign: 'right', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { fontSize: '12.5px', padding: '6px 8px', borderBottom: '1px solid var(--border)', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const btn: React.CSSProperties = { padding: '8px 14px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontWeight: 700, fontSize: '13px', cursor: 'pointer' };
const primaryBtn: React.CSSProperties = { ...btn, background: theme.orange, border: 'none', color: '#fff' };
const input: React.CSSProperties = { padding: '7px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '16px' };

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ ...card, marginBottom: 0, flex: '1 1 140px', minWidth: '140px' }}>
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: '20px', fontWeight: 800, marginTop: '2px', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{sub}</div>}
    </div>
  );
}

function GroupTable({ title, rows, labelHeader, labelFmt, csvName }: {
  title: string; rows: PayrollGroup[]; labelHeader: string; labelFmt?: (g: PayrollGroup) => string; csvName?: string;
}) {
  if (rows.length === 0) return null;
  const label = (g: PayrollGroup) => (labelFmt ? labelFmt(g) : g.label);
  const exportCsv = () => downloadCsv(csvName || 'payroll.csv',
    [labelHeader, 'People', 'Regular hrs', 'Overtime hrs', 'Overtime %', 'Regular pay', 'Overtime pay', 'Total earnings', 'ER benefits', 'ER taxes', 'Total labor cost', 'Cost per worked hr'],
    rows.map(g => [label(g), g.people, g.regular_hours, g.overtime_hours, g.overtime_pct ?? '', g.regular_amount, g.overtime_amount, g.total_earnings, g.er_benefits, g.er_taxes, g.total_labor_cost, g.loaded_rate ?? '']));
  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
        <div style={eyebrow}>{title}</div>
        <button style={{ ...btn, padding: '4px 10px', fontSize: '11px' }} onClick={exportCsv}>CSV</button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left' }}>{labelHeader}</th>
              <th style={th}>Worked hrs</th>
              <th style={th}>OT hrs</th>
              <th style={th}>OT %</th>
              <th style={th}>Earnings</th>
              <th style={th}>ER benefits</th>
              <th style={th}>ER taxes</th>
              <th style={th}>Labor cost</th>
              <th style={th}>Per worked hr</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(g => (
              <tr key={g.key}>
                <td style={{ ...td, textAlign: 'left', fontWeight: 600 }}>{label(g)}</td>
                <td style={td}>{fmtHrs(g.regular_hours + g.overtime_hours)}</td>
                <td style={td}>{fmtHrs(g.overtime_hours)}</td>
                <td style={td}>{g.overtime_pct == null ? '—' : `${g.overtime_pct}%`}</td>
                <td style={td}>{fmtMoney(g.total_earnings)}</td>
                <td style={td}>{fmtMoney(g.er_benefits)}</td>
                <td style={td}>{fmtMoney(g.er_taxes)}</td>
                <td style={{ ...td, fontWeight: 700 }}>{fmtMoney(g.total_labor_cost)}</td>
                <td style={td}>{fmtRate(g.loaded_rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReportTab({ data, onRange }: { data: Payload; onRange: (from: string, to: string) => void }) {
  const [from, setFrom] = useState(data.range.from);
  const [to, setTo] = useState(data.range.to);
  const r = data.report;
  const t = r.totals;
  const year = new Date().getFullYear();
  const preset = (f: string, tt: string) => { setFrom(f); setTo(tt); onRange(f, tt); };
  const ago = (days: number) => { const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().slice(0, 10); };
  const today = new Date().toISOString().slice(0, 10);
  const basis = data.shopCostBasis;

  return (
    <>
      <div style={{ ...card, display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
        <button style={btn} onClick={() => preset(`${year}-01-01`, `${year}-12-31`)}>This year</button>
        <button style={btn} onClick={() => preset(ago(91), today)}>Last 3 months</button>
        <button style={btn} onClick={() => preset(`${year - 1}-01-01`, `${year - 1}-12-31`)}>Last year</button>
        <span style={{ display: 'inline-flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="date" style={input} value={from} onChange={e => setFrom(e.target.value)} />
          <span style={{ color: 'var(--text-muted)' }}>to</span>
          <input type="date" style={input} value={to} onChange={e => setTo(e.target.value)} />
          <button style={btn} onClick={() => onRange(from, to)}>Go</button>
        </span>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', width: '100%' }}>Paychecks whose pay period ends in the range.</div>
      </div>

      {t.people === 0 ? (
        <div style={card}>No payroll in this range. Upload a Paychex file on the Upload tab.</div>
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '14px' }}>
            <Tile label="Total labor cost" value={fmtMoney(t.total_labor_cost)} sub={`${t.people} people`} />
            <Tile label="Earnings" value={fmtMoney(t.total_earnings)} sub={`ER taxes ${fmtMoney(t.er_taxes)} · benefits ${fmtMoney(t.er_benefits)}`} />
            <Tile label="Worked hours" value={fmtHrs(t.regular_hours + t.overtime_hours)} sub={`${fmtHrs(t.overtime_hours)} overtime (${t.overtime_pct ?? 0}%)`} />
            <Tile label="Cost per worked hour" value={fmtRate(t.loaded_rate)} sub="Everyone, loaded" />
          </div>
          <div style={{ ...card, fontSize: '12px', color: 'var(--text-secondary)' }}>
            <b>Shop labor on job costs:</b>{' '}
            {basis.source === 'paychex'
              ? <>Vehicle Margin is costing timer hours at {fmtRate(basis.rate)}/hr, the pooled payroll cost of the {basis.people} people on shop timers over the last 3 months of paychecks (through {fmtDate(basis.throughPeriodEnd || null)}).</>
              : basis.source === 'setting'
                ? <>Vehicle Margin is still using the blended Settings rate ({fmtRate(basis.rate)}/hr). It switches to payroll once at least 3 people who run shop timers are matched on the People tab.</>
                : <>No rate yet. Match the people who run shop timers on the People tab.</>}
          </div>
          <GroupTable title="By month" rows={r.byMonth} labelHeader="Month" labelFmt={g => fmtMonth(g.key)} csvName={`payroll-by-month-${data.range.from}-${data.range.to}.csv`} />
          <GroupTable title="By location" rows={r.byLocation} labelHeader="Location" csvName={`payroll-by-location-${data.range.from}-${data.range.to}.csv`} />
          <GroupTable title="By position" rows={r.byPosition} labelHeader="Position" csvName={`payroll-by-position-${data.range.from}-${data.range.to}.csv`} />
          <GroupTable title="By person" rows={r.byPerson} labelHeader="Employee" csvName={`payroll-by-person-${data.range.from}-${data.range.to}.csv`} />
          <GroupTable title="By pay period" rows={r.byPeriod} labelHeader="Pay period"
            labelFmt={g => { const [s, e] = g.key.split('|'); return `${fmtDate(s)} – ${fmtDate(e)}`; }}
            csvName={`payroll-by-period-${data.range.from}-${data.range.to}.csv`} />
        </>
      )}
    </>
  );
}

function UploadTab({ imports, onSaved }: { imports: ImportRow[]; onSaved: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [preview, setPreview] = useState<{ rows: number; employees: number; periods: PreviewPeriod[] } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (text: string, name: string, isPreview: boolean) => {
    setBusy(true); setErrors([]); setMessage(null);
    try {
      const res = await apiFetch('/api/reports/paychex-payroll/import', { method: 'POST', body: JSON.stringify({ csv: text, fileName: name, preview: isPreview }) });
      const json = await res.json();
      if (!res.ok) {
        setPreview(null);
        setErrors([json.error || 'Upload failed', ...(json.errors || []), ...(json.errorCount > (json.errors || []).length ? [`…and ${json.errorCount - json.errors.length} more`] : [])]);
      } else if (isPreview) {
        setPreview(json);
      } else {
        setMessage(`Saved ${json.inserted} paychecks${json.replaced ? `, replacing ${json.replaced} already on file for the same pay periods` : ''}.`);
        setPreview(null); setFile(null);
        if (fileRef.current) fileRef.current.value = '';
        onSaved();
      }
    } catch (e: any) {
      setErrors([e.message || 'Upload failed']);
    }
    setBusy(false);
  };

  const pick = async (f: File | undefined) => {
    if (!f) return;
    const text = await f.text();
    setFile({ name: f.name, text });
    send(text, f.name, true);
  };

  const totals = preview?.periods.reduce((a, p) => ({ cost: a.cost + p.total_labor_cost, replaces: a.replaces + p.replaces }), { cost: 0, replaces: 0 });

  return (
    <>
      <div style={card}>
        <div style={eyebrow}>Upload a Paychex file</div>
        <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: '10px' }}>
          In Paychex Flex, download the <b>Payroll Labor Cost</b> report as CSV and drop it here. You see what's in it before anything is saved.
          Uploading a pay period that's already here replaces it, so nothing is counted twice. Keep the report's 15 columns in their current order,
          because the file has no headings and FleetSuite reads the columns by position. A file that doesn't add up gets refused.
        </div>
        <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={e => pick(e.target.files?.[0])} disabled={busy} />
        {busy && <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '8px' }}>Reading…</div>}
        {message && <div style={{ marginTop: '10px', padding: '8px 12px', borderRadius: '8px', background: theme.successBg, color: theme.success, fontWeight: 700, fontSize: '13px' }}>{message}</div>}
        {errors.length > 0 && (
          <div style={{ marginTop: '10px', padding: '8px 12px', borderRadius: '8px', background: theme.errorBg, color: theme.error, fontSize: '12.5px' }}>
            {errors.map((e, i) => <div key={i} style={{ fontWeight: i === 0 ? 700 : 400 }}>{e}</div>)}
          </div>
        )}
      </div>

      {preview && file && totals && (
        <div style={card}>
          <div style={eyebrow}>Preview: {file.name}</div>
          <div style={{ fontSize: '13px', marginBottom: '8px' }}>
            {preview.rows} paychecks for {preview.employees} people across {preview.periods.length} pay periods, {fmtMoney(totals.cost)} total labor cost.
            {totals.replaces > 0 && <> Replaces {totals.replaces} paychecks already on file for those periods.</>}
          </div>
          <div style={{ overflowX: 'auto', marginBottom: '10px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={{ ...th, textAlign: 'left' }}>Pay period</th><th style={th}>Checks</th><th style={th}>Worked hrs</th><th style={th}>Labor cost</th><th style={th}>Already on file</th>
              </tr></thead>
              <tbody>
                {preview.periods.map(p => (
                  <tr key={`${p.period_start}|${p.period_end}`}>
                    <td style={{ ...td, textAlign: 'left' }}>{fmtDate(p.period_start)} – {fmtDate(p.period_end)}</td>
                    <td style={td}>{p.checks}</td>
                    <td style={td}>{fmtHrs(p.hours)}</td>
                    <td style={td}>{fmtMoney(p.total_labor_cost)}</td>
                    <td style={{ ...td, color: p.replaces ? theme.warning : 'var(--text-muted)' }}>{p.replaces ? `${p.replaces} (replaced)` : 'new'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button style={primaryBtn} disabled={busy} onClick={() => send(file.text, file.name, false)}>Save payroll</button>
            <button style={btn} disabled={busy} onClick={() => { setPreview(null); setFile(null); if (fileRef.current) fileRef.current.value = ''; }}>Cancel</button>
          </div>
        </div>
      )}

      {imports.length > 0 && (
        <div style={card}>
          <div style={eyebrow}>Recent uploads</div>
          {imports.map(i => (
            <div key={i.id} style={{ fontSize: '12.5px', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <b>{new Date(i.uploaded_at).toLocaleString()}</b>{i.uploaded_by_name ? ` by ${i.uploaded_by_name}` : ''}: {i.row_count} paychecks,{' '}
              {i.period_count} periods ({fmtDate(i.first_period_start)} – {fmtDate(i.last_period_end)}){i.replaced_rows ? `, replaced ${i.replaced_rows}` : ''}
              {i.file_name && <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{i.file_name}</div>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function PeopleTab({ employees, profiles, onSaved }: { employees: Employee[]; profiles: Payload['profiles']; onSaved: () => void }) {
  const initial = useMemo(() => Object.fromEntries(employees.map(e => [e.paychex_employee_id, e.profile_id || e.guess_profile_id || ''])), [employees]);
  const [picks, setPicks] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setPicks(initial), [initial]);

  const changed = employees.filter(e => (picks[e.paychex_employee_id] || '') !== (e.profile_id || ''));
  const taken = new Map<string, number>();
  for (const v of Object.values(picks)) if (v) taken.set(v, (taken.get(v) || 0) + 1);
  const dupes = [...taken.values()].some(n => n > 1);

  const save = async () => {
    setBusy(true); setMessage(null); setError(null);
    try {
      const res = await apiFetch('/api/reports/paychex-payroll/links', {
        method: 'POST',
        body: JSON.stringify({ links: changed.map(e => ({ paychexEmployeeId: e.paychex_employee_id, profileId: picks[e.paychex_employee_id] || null })) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Save failed');
      setMessage(`Saved ${json.saved} ${json.saved === 1 ? 'match' : 'matches'}.`);
      onSaved();
    } catch (e: any) {
      setError(e.message || 'Save failed');
    }
    setBusy(false);
  };

  if (employees.length === 0) return <div style={card}>Upload a Paychex file first. Its employees show up here to match.</div>;

  return (
    <div style={card}>
      <div style={eyebrow}>Match Paychex employees to FleetSuite people</div>
      <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', marginBottom: '10px', lineHeight: 1.5 }}>
        Matches let job costing use real payroll. Guesses by name are filled in and marked <i>suggested</i>. Check them, then save.
        Anyone who doesn't use FleetSuite can stay unmatched.
      </div>
      {employees.map(e => {
        const v = picks[e.paychex_employee_id] || '';
        const suggested = !e.profile_id && v && v === e.guess_profile_id;
        return (
          <div key={e.paychex_employee_id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
            <div style={{ flex: '1 1 180px', fontSize: '13px', fontWeight: 600 }}>
              {e.employee_name} <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: '11px' }}>#{e.paychex_employee_id}</span>
              {suggested && <span style={{ marginLeft: '6px', fontSize: '10px', fontWeight: 800, color: theme.warning }}>suggested</span>}
            </div>
            <select style={{ ...input, flex: '1 1 200px' }} value={v} onChange={ev => setPicks(p => ({ ...p, [e.paychex_employee_id]: ev.target.value }))}>
              <option value="">Not matched</option>
              {profiles.map(p => <option key={p.id} value={p.id}>{p.full_name || '(no name)'}</option>)}
            </select>
          </div>
        );
      })}
      {dupes && <div style={{ color: theme.error, fontSize: '12px', marginTop: '8px' }}>One person is picked for two Paychex employees.</div>}
      {message && <div style={{ color: theme.success, fontSize: '12px', marginTop: '8px', fontWeight: 700 }}>{message}</div>}
      {error && <div style={{ color: theme.error, fontSize: '12px', marginTop: '8px' }}>{error}</div>}
      <button style={{ ...primaryBtn, marginTop: '10px' }} disabled={busy || dupes || changed.length === 0} onClick={save}>
        {changed.length ? `Save ${changed.length} ${changed.length === 1 ? 'change' : 'changes'}` : 'No changes'}
      </button>
    </div>
  );
}

export default function PaychexPayrollPage() {
  const { hasFeature, loading: authLoading } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<'report' | 'upload' | 'people'>('report');
  const [data, setData] = useState<Payload | null>(null);
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Mirrors the routes' requireFinancials — super_admin / executive only.
  const allowed = hasFeature('financials');

  const load = useCallback(async (r: { from?: string; to?: string }) => {
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams(Object.entries(r).filter(([, v]) => v) as [string, string][]).toString();
      const res = await apiFetch(`/api/reports/paychex-payroll${qs ? `?${qs}` : ''}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Report failed');
      setData(json as Payload);
    } catch (e: any) {
      setError(e.message || 'Report failed');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!allowed) { router.push('/home'); return; }
    load(range);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasFeature identity changes per render; auth state deps cover it
  }, [authLoading, router, load]);

  const unmatched = data?.employees.filter(e => !e.profile_id).length || 0;
  const tabBtn = (key: typeof tab, label: string) => (
    <button key={key} onClick={() => setTab(key)} style={{
      ...btn, borderRadius: '999px', padding: '6px 14px',
      background: tab === key ? theme.tabActiveBg : 'var(--card)',
      borderColor: tab === key ? theme.tabActiveBorder : 'var(--border)',
      color: tab === key ? theme.tabActiveColor : 'var(--text-primary)',
    }}>{label}</button>
  );

  return (
    <div>
      <div style={{ marginBottom: '12px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Paychex Payroll</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Labor cost from Paychex Flex: wages, employer taxes and benefits, by pay period, location, position and person.</div>
      </div>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' }}>
        {tabBtn('report', 'Report')}
        {tabBtn('upload', 'Upload')}
        {tabBtn('people', unmatched ? `People (${unmatched} unmatched)` : 'People')}
      </div>
      {error && <div style={{ ...card, color: theme.error }}>{error}</div>}
      {loading && !data && <div style={card}>Loading…</div>}
      {data && tab === 'report' && <ReportTab data={data} onRange={(from, to) => { setRange({ from, to }); load({ from, to }); }} />}
      {data && tab === 'upload' && <UploadTab imports={data.imports} onSaved={() => load(range)} />}
      {data && tab === 'people' && <PeopleTab employees={data.employees} profiles={data.profiles} onSaved={() => load(range)} />}
    </div>
  );
}
