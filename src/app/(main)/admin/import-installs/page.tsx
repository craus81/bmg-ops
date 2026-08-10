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
  const [result, setResult] = useState<{ created: number; failed: number; credited: number; errors: { vin: string; error?: string }[] } | null>(null);
  // Pay credits (cni-redesign §1.6): when the company matches a real
  // companies row, its installer roster loads here and the checked members
  // get an equal credit split for every imported install.
  const [crewOptions, setCrewOptions] = useState<{ id: string; name: string }[]>([]);
  const [selectedCrew, setSelectedCrew] = useState<Set<string>>(new Set());
  // Near-duplicate rows from the last run, offered for an admin override
  // re-import (docs/cni-redesign.md §3.2 — soft flag, not a hard wall).
  const [lastDuplicates, setLastDuplicates] = useState<{ vin: string; part?: string }[]>([]);
  const [lastShiftId, setLastShiftId] = useState<string | null>(null);

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

  // Load the matched company's roster for the crew picker. Default: everyone
  // checked — imported work should pay unless the admin says otherwise.
  const matchedCompany = companies.find((c) => c.name.toLowerCase() === companyName.trim().toLowerCase()) || null;
  useEffect(() => {
    if (!matchedCompany) { setCrewOptions([]); setSelectedCrew(new Set()); return; }
    let cancelled = false;
    createClient()
      .from('profiles')
      .select('id, full_name')
      .eq('company_id', matchedCompany.id)
      .eq('status', 'approved')
      .order('full_name')
      .then(({ data }: { data: { id: string; full_name: string | null }[] | null }) => {
        if (cancelled) return;
        const opts = (data || []).map((p) => ({ id: p.id, name: p.full_name || 'Unnamed' }));
        setCrewOptions(opts);
        setSelectedCrew(new Set(opts.map((o) => o.id)));
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the resolved company id only
  }, [matchedCompany?.id]);

  // Multi-part (K8): the part field accepts a comma-separated list — the
  // first is the primary (carries the description), the rest are logged for
  // every vehicle on top of it. A row's own Part column overrides the primary.
  const partsList = useMemo(
    () => partNumber.split(',').map((p) => p.trim()).filter(Boolean),
    [partNumber],
  );
  const isRfid = partsList.some(isVerizonRfidPart);
  const hasRowParts = useMemo(() => (parsed?.rows || []).some((r) => r.partNumber), [parsed]);
  const validated = useMemo(
    () => (parsed?.rows || []).map((r) => {
      // RFID device fields are required when any part this row will log is
      // the Verizon RFID part (its own override, or the run's list).
      const rowParts = [r.partNumber?.trim() || partsList[0] || '', ...partsList.slice(1)];
      return { ...r, errors: rowErrors(r, rowParts.some(isVerizonRfidPart)) };
    }),
    [parsed, partsList],
  );
  const valid = validated.filter((r) => r.errors.length === 0);
  const canImport = companyName.trim().length > 0 && partsList.length > 0 && valid.length > 0 && !importing;

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
    const partsNote = partsList.length > 1 ? ` × ${partsList.length} parts (${partsList.join(', ')})` : '';
    const ok = await dialog.confirm(
      `Import ${valid.length} vehicle${valid.length !== 1 ? 's' : ''}${partsNote} credited to "${companyName.trim()}"? Duplicates already in the system are skipped.`,
      { confirmLabel: 'Import' },
    );
    if (!ok) return;

    setImporting(true);
    setResult(null);
    setLastDuplicates([]);
    let created = 0;
    let failed = 0;
    let credited = 0;
    let shiftId: string | null = null;
    const errors: { vin: string; error?: string }[] = [];
    const duplicates: { vin: string; part?: string }[] = [];
    setProgress({ done: 0, total: valid.length });
    for (let i = 0; i < valid.length; i += CHUNK) {
      const chunk = valid.slice(i, i + CHUNK);
      try {
        const res = await fetch('/api/admin/import-installs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            companyName: companyName.trim(),
            partNumber: partsList[0],
            partDescription: partDescription.trim() || undefined,
            billableCustomer: billableCustomer.trim() || undefined,
            locationName: locationName.trim() || undefined,
            additionalPartNumbers: partsList.length > 1 ? partsList.slice(1) : undefined,
            crewProfileIds: selectedCrew.size > 0 ? [...selectedCrew] : undefined,
            shiftId: shiftId || undefined,
            rows: chunk.map((r) => ({
              vin: r.vin,
              serialNumber: r.serialNumber || undefined,
              imei: r.imei || undefined,
              iccid: r.iccid || undefined,
              vehicleYear: r.vehicleYear || undefined,
              vehicleMake: r.vehicleMake || undefined,
              vehicleModel: r.vehicleModel || undefined,
              unitNumber: r.unitNumber || undefined,
              partNumber: r.partNumber || undefined,
            })),
          }),
        });
        const text = await res.text();
        let d: any = null;
        try { d = JSON.parse(text); } catch { /* non-JSON */ }
        if (!res.ok || !d) throw new Error(d?.error || `HTTP ${res.status}`);
        created += d.created || 0;
        failed += d.failed || 0;
        credited += d.credited || 0;
        if (d.shiftId) shiftId = d.shiftId;
        for (const rr of d.results || []) {
          if (rr.ok) continue;
          errors.push({ vin: rr.part ? `${rr.vin} (${rr.part})` : rr.vin, error: rr.error });
          if (rr.duplicate) duplicates.push({ vin: rr.vin, part: rr.part });
        }
      } catch (e: any) {
        failed += chunk.length;
        errors.push({ vin: '(chunk failed)', error: e?.message || 'request failed' });
      }
      setProgress({ done: Math.min(i + CHUNK, valid.length), total: valid.length });
    }
    setResult({ created, failed, credited, errors });
    setLastDuplicates(duplicates);
    setLastShiftId(shiftId);
    setImporting(false);
    setProgress(null);
  }

  // Admin override for near-duplicate rows (§3.2): re-attempt ONLY the
  // flagged (vin, part) combos with allowNearDuplicate. Exact repeats still
  // refuse server-side, so this can't create identical rows.
  async function importDuplicatesAnyway() {
    if (lastDuplicates.length === 0) return;
    const ok = await dialog.confirm(
      `Log ${lastDuplicates.length} flagged duplicate${lastDuplicates.length !== 1 ? 's' : ''} anyway? Use this when the collision is two different vehicles sharing a VIN last-8, or a deliberate re-log. Exact repeats are still refused.`,
      { confirmLabel: 'Log anyway' },
    );
    if (!ok) return;
    const rowByVin = new Map(valid.map((r) => [r.vin, r]));
    const overrideRows = lastDuplicates
      .map((dup) => {
        const r = rowByVin.get(dup.vin);
        return r ? { ...r, partNumber: dup.part || r.partNumber || partsList[0] } : null;
      })
      .filter((r): r is NonNullable<typeof r> => !!r);
    if (overrideRows.length === 0) return;

    setImporting(true);
    try {
      const res = await fetch('/api/admin/import-installs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyName: companyName.trim(),
          partNumber: partsList[0],
          partDescription: partDescription.trim() || undefined,
          billableCustomer: billableCustomer.trim() || undefined,
          locationName: locationName.trim() || undefined,
          // No additionalPartNumbers here: each override row targets exactly
          // one flagged (vin, part) combo via its own partNumber.
          crewProfileIds: !lastShiftId && selectedCrew.size > 0 ? [...selectedCrew] : undefined,
          shiftId: lastShiftId || undefined,
          overrideDuplicates: true,
          rows: overrideRows.map((r) => ({
            vin: r.vin,
            serialNumber: r.serialNumber || undefined,
            imei: r.imei || undefined,
            iccid: r.iccid || undefined,
            vehicleYear: r.vehicleYear || undefined,
            vehicleMake: r.vehicleMake || undefined,
            vehicleModel: r.vehicleModel || undefined,
            unitNumber: r.unitNumber || undefined,
            partNumber: r.partNumber || undefined,
          })),
        }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d) throw new Error(d?.error || `HTTP ${res.status}`);
      setResult((prev) => ({
        created: (prev?.created || 0) + (d.created || 0),
        failed: Math.max(0, (prev?.failed || 0) - (d.created || 0)),
        credited: (prev?.credited || 0) + (d.credited || 0),
        errors: (d.results || []).filter((rr: any) => !rr.ok).map((rr: any) => ({ vin: rr.part ? `${rr.vin} (${rr.part})` : rr.vin, error: rr.error })),
      }));
      if (d.shiftId) setLastShiftId(d.shiftId);
      setLastDuplicates([]);
    } catch (e: any) {
      await dialog.alert(`Override import failed: ${e?.message || 'request failed'}`);
    }
    setImporting(false);
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
          <label style={label}>Part number(s) *</label>
          <input style={input} value={partNumber} onChange={(e) => setPartNumber(e.target.value)} placeholder="Comma-separate for multi-part installs" />
          {partsList.length > 1 && (
            <div style={{ fontSize: 10, color: theme.textSecondary, fontWeight: 700, marginTop: 3 }}>
              {partsList.length} parts per vehicle — one install record each
            </div>
          )}
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

      {/* Pay credits — imported work used to be billable but never PAID */}
      <div style={card}>
        <label style={label}>Pay credits</label>
        {matchedCompany ? (
          crewOptions.length > 0 ? (
            <>
              <div style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 8 }}>
                Checked crew members split the pay for every imported install (equal split, at the part&apos;s field rate — unpriced parts land in the needs-pricing queue). Uncheck everyone to import without pay.
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {crewOptions.map((m) => (
                  <label key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', padding: '6px 10px', borderRadius: 8, border: `1px solid ${selectedCrew.has(m.id) ? theme.success : theme.border}`, background: selectedCrew.has(m.id) ? theme.successBg : theme.inputBg }}>
                    <input
                      type="checkbox"
                      checked={selectedCrew.has(m.id)}
                      onChange={(e) => {
                        setSelectedCrew((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(m.id); else next.delete(m.id);
                          return next;
                        });
                      }}
                    />
                    {m.name}
                  </label>
                ))}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 12, color: theme.warning }}>
              &quot;{matchedCompany.name}&quot; has no approved members — the import will be billable but nobody gets paid for it. Add members on the company page first if this work should pay.
            </div>
          )
        ) : (
          <div style={{ fontSize: 12, color: theme.textMuted }}>
            Pick a registered CNI company above to credit its crew — a free-text company imports as billable work with no pay credits.
          </div>
        )}
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
                  <th style={th}>Year</th><th style={th}>Make</th><th style={th}>Model</th>
                  {hasRowParts && <th style={th}>Part</th>}
                  <th style={th}>Status</th>
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
                    {hasRowParts && <td style={td}>{r.partNumber || `(${partsList[0] || 'default'})`}</td>}
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
          <div style={{ fontSize: 14 }}>
            Imported <strong>{result.created}</strong>, skipped/failed <strong>{result.failed}</strong>
            {result.credited > 0 && <>, pay credits written for <strong>{result.credited}</strong></>}.
          </div>
          {lastDuplicates.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <button onClick={importDuplicatesAnyway} disabled={importing} style={{ ...btn, background: theme.orange, opacity: importing ? 0.5 : 1 }}>
                Log {lastDuplicates.length} flagged duplicate{lastDuplicates.length !== 1 ? 's' : ''} anyway
              </button>
              <span style={{ marginLeft: 10, fontSize: 12, color: theme.textSecondary }}>
                Duplicate flags compare the VIN last-8 — override when they&apos;re really different vehicles (or a deliberate re-log). Exact repeats stay blocked.
              </span>
            </div>
          )}
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
