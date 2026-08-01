'use client';

import { useMemo, useState, useEffect, useRef, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import { isVerizonRfidPart, validateSerial, validateImei, validateIccid, VERIZON_RFID_PART } from '@/lib/rfid';
import { parsePastedText, parseSpreadsheetFile, looksLikeVin, type ImportRow as Row, type ParseOutcome } from '@/lib/import-installs-parse';
import { loadCompaniesWithCounts, type CompanyOption } from '@/lib/cni-companies';
import CustomerPicker from '@/components/CustomerPicker';

const CHUNK = 100;

/**
 * Company name input with a typeahead over the shared `companies` table (the
 * CNI company list). The import API stamps the name as free text on purpose —
 * work can be credited to a company that hasn't registered yet — so an
 * unmatched name is allowed, but flagged so a typo doesn't silently split an
 * installer's history across two spellings.
 */
function CompanyNameField({ value, onChange, companies, inputStyle }: {
  value: string;
  onChange: (v: string) => void;
  companies: CompanyOption[];
  inputStyle: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const q = value.trim().toLowerCase();
  const matches = (q ? companies.filter((c) => c.name.toLowerCase().includes(q)) : companies).slice(0, 8);
  const exact = q ? companies.find((c) => c.name.toLowerCase() === q) : undefined;

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <input
        style={inputStyle}
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="CNI company name"
      />
      {value.trim() && !open && (
        exact ? (
          <div style={{ fontSize: 10, color: theme.success, fontWeight: 700, marginTop: 3 }}>✓ Existing CNI company</div>
        ) : (
          <div style={{ fontSize: 10, color: theme.warning, fontWeight: 700, marginTop: 3 }}>
            Not a known CNI company — will be stamped as typed; pick from the list to avoid typos
          </div>
        )
      )}
      {open && matches.length > 0 && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.35)', zIndex: 60, maxHeight: 240, overflowY: 'auto' }}>
          {matches.map((c) => (
            <div
              key={c.id}
              onClick={() => { onChange(c.name); setOpen(false); }}
              style={{ padding: '8px 10px', cursor: 'pointer', fontSize: 12, borderBottom: `1px solid ${theme.border}` }}
            >
              <div style={{ fontWeight: 700, color: theme.textPrimary }}>{c.name}</div>
              <div style={{ fontSize: 10, color: theme.textMuted }}>{c.memberCount} installer{c.memberCount !== 1 ? 's' : ''}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function rowErrors(r: Row, isRfid: boolean): string[] {
  const errs: string[] = [];
  if (!looksLikeVin(r.vin)) errs.push('VIN');
  if (isRfid) {
    if (!validateSerial(r.serialNumber)) errs.push('SN');
    if (!validateImei(r.imei)) errs.push('IMEI');
    if (!validateIccid(r.iccid)) errs.push('CCID');
  }
  return errs;
}

export default function ImportInstallsPage() {
  const router = useRouter();
  const { isAdmin } = useAuth();
  const dialog = useDialog();

  const [companyName, setCompanyName] = useState('');
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [partNumber, setPartNumber] = useState(VERIZON_RFID_PART);
  const [partDescription, setPartDescription] = useState('Verizon RFID Install');
  const [billableCustomer, setBillableCustomer] = useState('');
  const [billableNsId, setBillableNsId] = useState<string | null>(null);
  const [locationName, setLocationName] = useState('');

  const [raw, setRaw] = useState('');
  const [parsed, setParsed] = useState<ParseOutcome | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsingFile, setParsingFile] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ created: number; failed: number; errors: { vin: string; error?: string }[] } | null>(null);

  useEffect(() => {
    if (isAdmin === false) router.push('/home');
  }, [isAdmin, router]);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    loadCompaniesWithCounts(createClient()).then((list) => {
      if (!cancelled) setCompanies(list);
    });
    return () => { cancelled = true; };
  }, [isAdmin]);

  const isRfid = isVerizonRfidPart(partNumber);
  const validated = useMemo(
    () => (parsed?.rows || []).map((r) => ({ ...r, errors: rowErrors(r, isRfid) })),
    [parsed, isRfid],
  );
  const valid = validated.filter((r) => r.errors.length === 0);
  const canImport = companyName.trim().length > 0 && partNumber.trim().length > 0 && valid.length > 0 && !importing;

  async function handleFile(file: File) {
    setParsingFile(true);
    try {
      const outcome = await parseSpreadsheetFile(file);
      setParsed(outcome);
      setFileName(file.name);
      setResult(null);
    } catch (e: any) {
      await dialog.alert(e?.message || 'Could not read that file.');
    }
    setParsingFile(false);
  }

  function parseRaw() {
    setParsed(parsePastedText(raw));
    setFileName(null);
    setResult(null);
  }

  async function doImport() {
    if (!canImport) return;
    const ok = await dialog.confirm(
      `Import ${valid.length} install${valid.length !== 1 ? 's' : ''} credited to "${companyName.trim()}"? Duplicates already in the system are skipped.`,
      { confirmLabel: 'Import' },
    );
    if (!ok) return;

    setImporting(true);
    setResult(null);
    let created = 0;
    let failed = 0;
    const errors: { vin: string; error?: string }[] = [];
    setProgress({ done: 0, total: valid.length });
    for (let i = 0; i < valid.length; i += CHUNK) {
      const chunk = valid.slice(i, i + CHUNK);
      try {
        const res = await fetch('/api/admin/import-installs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            companyName: companyName.trim(),
            partNumber: partNumber.trim(),
            partDescription: partDescription.trim() || undefined,
            billableCustomer: billableCustomer.trim() || undefined,
            locationName: locationName.trim() || undefined,
            rows: chunk.map((r) => ({
              vin: r.vin,
              serialNumber: r.serialNumber || undefined,
              imei: r.imei || undefined,
              iccid: r.iccid || undefined,
              vehicleYear: r.vehicleYear || undefined,
              vehicleMake: r.vehicleMake || undefined,
              vehicleModel: r.vehicleModel || undefined,
              unitNumber: r.unitNumber || undefined,
            })),
          }),
        });
        const text = await res.text();
        let d: any = null;
        try { d = JSON.parse(text); } catch { /* non-JSON */ }
        if (!res.ok || !d) throw new Error(d?.error || `HTTP ${res.status}`);
        created += d.created || 0;
        failed += d.failed || 0;
        for (const rr of d.results || []) if (!rr.ok) errors.push({ vin: rr.vin, error: rr.error });
      } catch (e: any) {
        failed += chunk.length;
        errors.push({ vin: '(chunk failed)', error: e?.message || 'request failed' });
      }
      setProgress({ done: Math.min(i + CHUNK, valid.length), total: valid.length });
    }
    setResult({ created, failed, errors });
    setImporting(false);
    setProgress(null);
  }

  const card: CSSProperties = { background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 12, padding: 16, marginBottom: 16 };
  const label: CSSProperties = { display: 'block', fontSize: 12, color: theme.textSecondary, marginBottom: 4, fontWeight: 600 };
  const input: CSSProperties = { width: '100%', background: theme.inputBg, color: theme.textPrimary, border: `1px solid ${theme.border}`, borderRadius: 8, padding: '8px 10px', fontSize: 14 };
  const btn: CSSProperties = { background: theme.orange, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 18px', fontWeight: 600, fontSize: 14, cursor: 'pointer' };

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: 16, color: theme.textPrimary }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Import Installs</h1>
      <p style={{ color: theme.textSecondary, fontSize: 14, marginBottom: 16 }}>
        Bulk-load vehicle installs from a spreadsheet and credit them to a CNI installer. Each row becomes an
        install record (in the scan log, ready for reporting and invoicing). Upload the file below — include a
        header row with <strong>VIN, SN, IMEI, CCID</strong> (year / make / model / unit optional).
      </p>

      <div style={{ ...card, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <div>
          <label style={label}>Credit to company *</label>
          <CompanyNameField value={companyName} onChange={setCompanyName} companies={companies} inputStyle={input} />
        </div>
        <div>
          <label style={label}>Part number *</label>
          <input style={input} value={partNumber} onChange={(e) => setPartNumber(e.target.value)} />
        </div>
        <div>
          <label style={label}>Part description</label>
          <input style={input} value={partDescription} onChange={(e) => setPartDescription(e.target.value)} />
        </div>
        <div>
          <label style={label}>Billable customer (for invoicing)</label>
          {/* Invoicing later resolves this name in NetSuite (findCustomer), so an
              unmatched spelling fails at billing time — match it here instead. */}
          <CustomerPicker
            value={billableCustomer}
            netsuiteId={billableNsId}
            onChange={({ customer, customerNetsuiteId }) => { setBillableCustomer(customer); setBillableNsId(customerNetsuiteId); }}
            placeholder="Who gets invoiced"
          />
        </div>
        <div>
          <label style={label}>Location (optional)</label>
          <input style={input} value={locationName} onChange={(e) => setLocationName(e.target.value)} />
        </div>
      </div>

      <div style={card}>
        <label style={label}>Upload the spreadsheet (.xlsx, .csv, .tsv)</label>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xlsm,.csv,.tsv,.txt"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = ''; // allow re-picking the same file after fixing it
            if (f) handleFile(f);
          }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={parsingFile}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
          style={{
            width: '100%', padding: '22px 16px', borderRadius: 10, cursor: 'pointer', fontSize: 14, fontWeight: 600,
            border: `2px dashed ${dragOver ? theme.orange : theme.border}`,
            background: dragOver ? theme.subtleBg : theme.inputBg,
            color: fileName ? theme.textPrimary : theme.textSecondary,
          }}
        >
          {parsingFile ? 'Reading…' : fileName ? `📄 ${fileName} — click to replace` : '📄 Drop the spreadsheet here, or click to choose'}
        </button>

        <div style={{ margin: '14px 0 8px', display: 'flex', alignItems: 'center', gap: 10, color: theme.textMuted, fontSize: 12 }}>
          <div style={{ flex: 1, height: 1, background: theme.border }} />
          or paste rows (copy the cells from Excel/Sheets)
          <div style={{ flex: 1, height: 1, background: theme.border }} />
        </div>

        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={6}
          spellCheck={false}
          style={{ ...input, fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
          placeholder={'VIN\tSN\tIMEI\tCCID\n1FTBW2CM9...\tABC123\t357...15digits\t8914...19digits'}
        />
        <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={parseRaw} disabled={!raw.trim()} style={{ ...btn, opacity: raw.trim() ? 1 : 0.5 }}>
            Parse
          </button>
          {parsed && (
            <span style={{ fontSize: 13, color: theme.textSecondary }}>
              {fileName && parsed.sheetName && <>sheet “{parsed.sheetName}” of {parsed.sheetCount} · </>}
              {validated.length} rows · <strong style={{ color: theme.success }}>{valid.length} valid</strong>
              {validated.length - valid.length > 0 && <> · <strong style={{ color: theme.warning }}>{validated.length - valid.length} need fixing</strong></>}
              {parsed.mode === 'positional' && <> · <span style={{ color: theme.warning }}>no header row — assumed VIN, SN, IMEI, CCID order; check the preview</span></>}
              {parsed.mode === 'empty' && <span style={{ color: theme.warning }}>no rows found</span>}
            </span>
          )}
        </div>
      </div>

      {parsed && validated.length > 0 && (
        <>
          {isRfid && (
            <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 8 }}>
              Verizon RFID part — SN (4+ chars), IMEI (15 digits), and CCID (18–22 digits) are required and validated per row.
            </div>
          )}
          <div style={{ ...card, padding: 0, overflow: 'auto', maxHeight: 460 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: theme.subtleBg, textAlign: 'left', position: 'sticky', top: 0 }}>
                  <th style={th}>VIN</th><th style={th}>SN</th><th style={th}>IMEI</th><th style={th}>CCID</th>
                  <th style={th}>Year</th><th style={th}>Make</th><th style={th}>Model</th><th style={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {validated.slice(0, 1000).map((r, i) => (
                  <tr key={i} style={{ borderTop: `1px solid ${theme.border}`, background: r.errors.length ? theme.warningBg : 'transparent' }}>
                    <td style={{ ...td, fontFamily: 'monospace' }}>{r.vin || '—'}</td>
                    <td style={td}>{r.serialNumber || '—'}</td>
                    <td style={td}>{r.imei || '—'}</td>
                    <td style={td}>{r.iccid || '—'}</td>
                    <td style={td}>{r.vehicleYear || '—'}</td>
                    <td style={td}>{r.vehicleMake || '—'}</td>
                    <td style={td}>{r.vehicleModel || '—'}</td>
                    <td style={{ ...td, color: r.errors.length ? theme.warning : theme.success, fontWeight: 600 }}>
                      {r.errors.length ? `fix: ${r.errors.join(', ')}` : 'ok'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {validated.length > 1000 && (
              <div style={{ padding: 8, fontSize: 12, color: theme.textMuted }}>Showing first 1000 of {validated.length}.</div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16 }}>
            <button onClick={doImport} disabled={!canImport} style={{ ...btn, background: theme.success, opacity: canImport ? 1 : 0.5 }}>
              {importing ? 'Importing…' : `Import ${valid.length} install${valid.length !== 1 ? 's' : ''}`}
            </button>
            {!companyName.trim() && <span style={{ fontSize: 12, color: theme.warning }}>Enter the company to credit.</span>}
          </div>
        </>
      )}

      {progress && (
        <div style={card}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Importing… {progress.done}/{progress.total}</div>
          <div style={{ height: 8, background: theme.progressTrack, borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(progress.done / progress.total) * 100}%`, background: theme.orange }} />
          </div>
        </div>
      )}

      {result && (
        <div style={{ ...card, background: result.failed ? theme.warningBg : theme.successBg, borderColor: result.failed ? theme.warningBorder : theme.successBorder }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Done</div>
          <div style={{ fontSize: 14 }}>Imported <strong>{result.created}</strong>, skipped/failed <strong>{result.failed}</strong>.</div>
          {result.errors.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 12, color: theme.textSecondary, maxHeight: 160, overflow: 'auto' }}>
              {result.errors.slice(0, 100).map((e, i) => (
                <div key={i}>{e.vin}: {e.error}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const th: CSSProperties = { padding: '8px 10px', fontWeight: 600, fontSize: 11, color: theme.textSecondary, whiteSpace: 'nowrap' };
const td: CSSProperties = { padding: '6px 10px', whiteSpace: 'nowrap' };
