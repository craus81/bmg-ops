'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { storage } from '@/lib/storage';
import { apiFetch } from '@/lib/api-client';
import { DropZone } from '@/components/DropZone';
import UploadProgressBar, { type UploadProgress } from '@/components/UploadProgressBar';
import type { CatalogItem } from '@/lib/types';

interface ZipFileEntry {
  path: string;
  name: string;
  ext: string;
  size: number;
  folderParts: string[];
  suggested: Record<string, string>;
  hasThumbnail?: boolean;
  thumbnailPath?: string;
}

interface TemplateRow extends ZipFileEntry {
  include: boolean;
  make: string;
  model: string;
  year: string;
  variant: string;
  wheelbase: string;
  doors: string;
  roofHeight: string;
  windows: string;
  displayName: string;
}

interface ProofRow extends ZipFileEntry {
  include: boolean;
  customer: string;
  vehicleType: string;
  catalogId: string | null;
  customerOverridden?: boolean;
}

type Tab = 'templates' | 'proofs';

const STICKY_CUSTOMER_KEY = 'bulk_upload_sticky_customer';

export default function BulkUploadPage() {
  const router = useRouter();
  const { isAdmin, user, loading: authLoading } = useAuth();
  const supabase = createClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [tab, setTab] = useState<Tab>('templates');
  const [loading, setLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState('');

  // The selected ZIP is staged in R2 via presigned upload (no request-size
  // limit), then referenced by key for parsing and chunked processing.
  const [zipPath, setZipPath] = useState<string | null>(null);
  const [uploadNote, setUploadNote] = useState('');

  // Template state
  const [templateRows, setTemplateRows] = useState<TemplateRow[]>([]);

  // Proof state
  const [proofRows, setProofRows] = useState<ProofRow[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [stickyCustomer, setStickyCustomer] = useState('');

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<any>(null);

  useEffect(() => {
    if (authLoading) return; // role flags aren't resolved until auth finishes loading
    if (!isAdmin) { router.push('/home'); return; }
    // Load catalog for proof matching
    const loadCatalog = async () => {
      const { data } = await supabase.from('catalog').select('*').order('part_number');
      setCatalog((data as CatalogItem[]) || []);
    };
    loadCatalog();
    // Restore sticky customer from previous session
    try {
      const saved = localStorage.getItem(STICKY_CUSTOMER_KEY);
      if (saved) setStickyCustomer(saved);
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [authLoading, isAdmin]);

  // Persist sticky customer
  useEffect(() => {
    try {
      if (stickyCustomer) localStorage.setItem(STICKY_CUSTOMER_KEY, stickyCustomer);
      else localStorage.removeItem(STICKY_CUSTOMER_KEY);
    } catch {}
  }, [stickyCustomer]);

  // Unique customer list from catalog plus any customers detected from current proof rows (sorted)
  const customerOptions = Array.from(
    new Set([
      ...catalog.map(c => c.end_customer).filter((v): v is string => !!v && v.trim().length > 0),
      ...proofRows.map(r => r.customer).filter(v => !!v && v.trim().length > 0),
      ...(stickyCustomer ? [stickyCustomer] : []),
    ])
  ).sort((a, b) => a.localeCompare(b));

  const handleZipSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    handleZipFile(file);
  };

  const handleZipFile = async (file: File) => {
    setError('');
    setUploadResult(null);
    setLoading(true);

    try {
      // Stage the ZIP in R2 first — bulk ZIPs far exceed the ~4.5MB
      // serverless request-body limit, so it never travels through the API.
      let safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      if (!/\.zip$/i.test(safeName)) safeName += '.zip';
      const stagedPath = `zips/${Date.now()}-${safeName}`.slice(0, 200);
      setUploadProgress({ fileName: file.name, fileIndex: 1, fileCount: 1, loaded: 0, total: file.size });
      const { error: upErr } = await storage.from('vehicle-templates').upload(stagedPath, file, {
        contentType: 'application/zip',
        onProgress: (loaded, total) => setUploadProgress({ fileName: file.name, fileIndex: 1, fileCount: 1, loaded, total }),
      });
      setUploadProgress(null);
      if (upErr) throw new Error(`ZIP upload failed: ${upErr.message}`);
      setZipPath(stagedPath);

      const res = await apiFetch(`/api/admin/upload-zip?type=${tab}`, {
        method: 'POST',
        body: JSON.stringify({ zipPath: stagedPath }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      if (tab === 'templates') {
        setTemplateRows(data.files.map((f: ZipFileEntry) => ({
          ...f,
          include: true,
          make: f.suggested.make || '',
          model: f.suggested.model || '',
          year: f.suggested.year || '',
          variant: '',
          wheelbase: '',
          doors: '',
          roofHeight: '',
          windows: '',
          displayName: f.suggested.name || f.name,
        })));
      } else {
        // For proofs, try to auto-match to catalog items by customer
        setProofRows(data.files.map((f: ZipFileEntry) => {
          const detected = f.suggested.customer || '';
          const customer = detected || stickyCustomer;
          const vehicleType = f.suggested.vehicle_type || '';
          // Try to find a matching catalog item
          const match = customer ? catalog.find(c =>
            c.end_customer?.toLowerCase() === customer.toLowerCase() ||
            c.customer?.toLowerCase() === customer.toLowerCase()
          ) : undefined;
          return {
            ...f,
            include: true,
            customer,
            vehicleType,
            catalogId: match?.id || null,
          };
        }));
      }
    } catch (err: any) {
      setError(err.message || 'Failed to process ZIP');
    }
    setLoading(false);
    // Reset the file input so the same file can be re-selected
    if (fileRef.current) fileRef.current.value = '';
  };

  // Process in chunks so each server call stays inside the serverless time
  // budget regardless of how many templates the ZIP holds.
  const CHUNK = 12;

  const handleUploadTemplates = async () => {
    if (!zipPath) return;
    setUploading(true);
    setError('');

    const entries = templateRows.filter(r => r.include).map(r => ({
      path: r.path,
      thumbnailPath: r.thumbnailPath,
      name: r.displayName,
      make: r.make,
      model: r.model,
      year: r.year,
      variant: r.variant,
      wheelbase: r.wheelbase,
      doors: r.doors,
      roofHeight: r.roofHeight,
      windows: r.windows,
      include: true,
    }));

    try {
      const allResults: any[] = [];
      for (let i = 0; i < entries.length; i += CHUNK) {
        setUploadNote(`Uploading ${Math.min(i + CHUNK, entries.length)} of ${entries.length} templates…`);
        const res = await apiFetch('/api/admin/bulk-upload-templates', {
          method: 'POST',
          body: JSON.stringify({ zipPath, manifest: entries.slice(i, i + CHUNK) }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        allResults.push(...(data.results || []));
      }
      const success = allResults.filter(r => r.status === 'success').length;
      const errors = allResults.filter(r => r.status === 'error').length;
      setUploadResult({
        message: `Uploaded ${success} template${success !== 1 ? 's' : ''}${errors > 0 ? `, ${errors} error${errors !== 1 ? 's' : ''}` : ''}`,
        results: allResults,
        summary: { total: entries.length, success, errors },
      });
      // Done with the staged ZIP — clean it up (best-effort)
      storage.from('vehicle-templates').remove([zipPath]).catch(() => {});
    } catch (err: any) {
      setError(err.message || 'Upload failed');
    }
    setUploadNote('');
    setUploading(false);
  };

  const handleUploadProofs = async () => {
    if (!zipPath) return;
    setUploading(true);
    setError('');

    const entries = proofRows.filter(r => r.include && r.catalogId).map(r => ({
      path: r.path,
      name: r.name,
      catalogId: r.catalogId,
      customer: r.customer,
      vehicleType: r.vehicleType,
      include: true,
    }));

    try {
      const allResults: any[] = [];
      for (let i = 0; i < entries.length; i += CHUNK) {
        setUploadNote(`Uploading ${Math.min(i + CHUNK, entries.length)} of ${entries.length} proofs…`);
        const res = await apiFetch('/api/admin/bulk-upload-proofs', {
          method: 'POST',
          body: JSON.stringify({ zipPath, manifest: entries.slice(i, i + CHUNK) }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        allResults.push(...(data.results || []));
      }
      const success = allResults.filter(r => r.status === 'success').length;
      const errors = allResults.filter(r => r.status === 'error').length;
      setUploadResult({
        message: `Uploaded ${success} proof${success !== 1 ? 's' : ''}${errors > 0 ? `, ${errors} error${errors !== 1 ? 's' : ''}` : ''}`,
        results: allResults,
        summary: { total: entries.length, success, errors },
      });
      storage.from('vehicle-templates').remove([zipPath]).catch(() => {});
    } catch (err: any) {
      setError(err.message || 'Upload failed');
    }
    setUploadNote('');
    setUploading(false);
  };

  const updateTemplateRow = (index: number, field: keyof TemplateRow, value: any) => {
    setTemplateRows(prev => prev.map((r, i) => i === index ? { ...r, [field]: value } : r));
  };

  const updateProofRow = (index: number, field: keyof ProofRow, value: any) => {
    setProofRows(prev => prev.map((r, i) => i === index ? { ...r, [field]: value } : r));
  };

  // Change a row's customer and make it sticky for subsequent rows that haven't been overridden
  const changeRowCustomer = (index: number, value: string) => {
    setStickyCustomer(value);
    setProofRows(prev => prev.map((r, i) => {
      if (i === index) {
        const match = value ? catalog.find(c =>
          c.end_customer?.toLowerCase() === value.toLowerCase() ||
          c.customer?.toLowerCase() === value.toLowerCase()
        ) : undefined;
        return { ...r, customer: value, customerOverridden: true, catalogId: match?.id || r.catalogId };
      }
      // Apply to later rows that haven't been individually overridden
      if (i > index && !r.customerOverridden) {
        const match = value ? catalog.find(c =>
          c.end_customer?.toLowerCase() === value.toLowerCase() ||
          c.customer?.toLowerCase() === value.toLowerCase()
        ) : undefined;
        return { ...r, customer: value, catalogId: match?.id || r.catalogId };
      }
      return r;
    }));
  };

  // Apply sticky customer to all rows (header-level action)
  const applyStickyCustomerToAll = (value: string) => {
    setStickyCustomer(value);
    setProofRows(prev => prev.map(r => {
      if (r.customerOverridden) return r;
      const match = value ? catalog.find(c =>
        c.end_customer?.toLowerCase() === value.toLowerCase() ||
        c.customer?.toLowerCase() === value.toLowerCase()
      ) : undefined;
      return { ...r, customer: value, catalogId: match?.id || r.catalogId };
    }));
  };

  // Group template rows by make/model/year for nicer display
  const groupedTemplates: Record<string, TemplateRow[]> = {};
  templateRows.forEach(r => {
    const key = [r.make, r.model, r.year].filter(Boolean).join(' / ') || 'Ungrouped';
    if (!groupedTemplates[key]) groupedTemplates[key] = [];
    groupedTemplates[key].push(r);
  });

  // Group proof rows by customer
  const groupedProofs: Record<string, ProofRow[]> = {};
  proofRows.forEach(r => {
    const key = r.customer || 'Unknown Customer';
    if (!groupedProofs[key]) groupedProofs[key] = [];
    groupedProofs[key].push(r);
  });

  const selectedTemplateCount = templateRows.filter(r => r.include).length;
  const selectedProofCount = proofRows.filter(r => r.include && r.catalogId).length;
  const unmatchedProofCount = proofRows.filter(r => r.include && !r.catalogId).length;

  const fmt = (bytes: number) => bytes < 1024 ? `${bytes}B` : bytes < 1048576 ? `${(bytes/1024).toFixed(0)}KB` : `${(bytes/1048576).toFixed(1)}MB`;

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '6px 8px', borderRadius: '6px',
    border: '1px solid var(--border)', background: 'var(--input-bg)',
    color: 'var(--text-primary)', fontSize: '11px',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)',
    textTransform: 'uppercase', letterSpacing: '0.3px',
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 0' }}>
        <div style={{ width: '36px', height: '36px', border: '3px solid var(--border)', borderTopColor: 'var(--orange)', borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
        <div style={{ color: 'var(--text-muted)', marginTop: '12px', fontSize: '13px', fontWeight: 600 }}>
          {uploadProgress ? 'Uploading ZIP…' : 'Processing ZIP file...'}
        </div>
        <UploadProgressBar progress={uploadProgress} />
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: '22px', fontWeight: 800, marginBottom: '16px' }}>Bulk Upload</div>

      {/* Tab Bar */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '14px', background: 'var(--card)', borderRadius: '10px', padding: '3px' }}>
        <button onClick={() => { setTab('templates'); setTemplateRows([]); setProofRows([]); setZipPath(null); setUploadResult(null); setError(''); }} style={{ flex: 1, padding: '10px', borderRadius: '8px', fontSize: '13px', fontWeight: 700, background: tab === 'templates' ? 'var(--tab-active-bg)' : 'transparent', border: 'none', color: tab === 'templates' ? 'var(--text-primary)' : 'var(--text-muted)' }}>
          Vehicle Templates
        </button>
        <button onClick={() => { setTab('proofs'); setTemplateRows([]); setProofRows([]); setZipPath(null); setUploadResult(null); setError(''); }} style={{ flex: 1, padding: '10px', borderRadius: '8px', fontSize: '13px', fontWeight: 700, background: tab === 'proofs' ? 'var(--tab-active-bg)' : 'transparent', border: 'none', color: tab === 'proofs' ? 'var(--text-primary)' : 'var(--text-muted)' }}>
          Proofs
        </button>
      </div>

      {/* Upload Result */}
      {uploadResult && (
        <div style={{
          padding: '12px', borderRadius: '10px', marginBottom: '14px',
          background: uploadResult.summary?.errors > 0 ? 'var(--warning-bg)' : 'var(--success-bg)',
          border: `1px solid ${uploadResult.summary?.errors > 0 ? 'var(--warning-border)' : 'var(--success-border)'}`,
          color: uploadResult.summary?.errors > 0 ? 'var(--warning)' : 'var(--success)',
          fontSize: '13px', fontWeight: 700,
        }}>
          {uploadResult.message}
          {uploadResult.results?.filter((r: any) => r.status === 'error').map((r: any, i: number) => (
            <div key={i} style={{ fontSize: '11px', fontWeight: 400, marginTop: '4px' }}>
              {r.name}: {r.error}
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ padding: '10px', borderRadius: '10px', marginBottom: '12px', background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)', fontSize: '12px', fontWeight: 600 }}>
          {error}
        </div>
      )}

      {/* ZIP Upload */}
      {(tab === 'templates' ? templateRows.length === 0 : proofRows.length === 0) && !uploadResult && (
        <div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px' }}>
            {tab === 'templates'
              ? 'Upload a ZIP file containing your vehicle templates (EPS files). Folder structure should be: Make/Category/Model/Year/files.eps — JPG/PNG files with matching names will be used as thumbnails.'
              : 'Upload a ZIP file containing your proofs (PDF files). Folder structure should be: Customer/VehicleType/files.pdf — files will be matched to catalog items.'}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".zip"
            onChange={handleZipSelect}
            style={{ display: 'none' }}
          />
          <DropZone accept=".zip" multiple={false} onFiles={files => handleZipFile(files[0])}>
          <button
            onClick={() => fileRef.current?.click()}
            style={{
              width: '100%', padding: '40px 20px', borderRadius: '14px',
              border: '2px dashed var(--border)', background: 'var(--card)',
              color: 'var(--text-secondary)', fontSize: '15px', fontWeight: 700,
              cursor: 'pointer', textAlign: 'center',
            }}
          >
            Select ZIP File
          </button>
          </DropZone>
        </div>
      )}

      {/* ═══════════ TEMPLATE REVIEW ═══════════ */}
      {tab === 'templates' && templateRows.length > 0 && !uploadResult && (
        <div>
          {/* Summary bar */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '10px 14px', borderRadius: '10px', marginBottom: '12px',
            background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)',
          }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: '#60a5fa' }}>
              {selectedTemplateCount} of {templateRows.length} templates selected
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button onClick={() => setTemplateRows(prev => prev.map(r => ({ ...r, include: true })))} style={{ padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', color: '#60a5fa' }}>Select All</button>
              <button onClick={() => setTemplateRows(prev => prev.map(r => ({ ...r, include: false })))} style={{ padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>Deselect All</button>
            </div>
          </div>

          {/* Apply same values to all in a group */}
          {Object.entries(groupedTemplates).map(([group, rows]) => (
            <div key={group} style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '8px', padding: '6px 10px', background: 'var(--subtle-bg)', borderRadius: '8px' }}>
                {group} ({rows.length} file{rows.length !== 1 ? 's' : ''})
              </div>

              {rows.map(row => {
                const idx = templateRows.indexOf(row);
                return (
                  <div key={row.path} style={{
                    padding: '10px', marginBottom: '6px', borderRadius: '10px',
                    background: row.include ? 'var(--card)' : 'var(--subtle-bg)',
                    border: `1px solid ${row.include ? 'var(--border)' : 'transparent'}`,
                    opacity: row.include ? 1 : 0.5,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                      <input
                        type="checkbox"
                        checked={row.include}
                        onChange={(e) => updateTemplateRow(idx, 'include', e.target.checked)}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '12px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</div>
                        <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                          {row.ext.toUpperCase()} · {fmt(row.size)}
                          {row.hasThumbnail && <span style={{ color: 'var(--success)', marginLeft: '6px' }}>✓ has thumbnail</span>}
                        </div>
                      </div>
                    </div>

                    {row.include && (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '6px' }}>
                        <div>
                          <div style={labelStyle}>Name</div>
                          <input style={inputStyle} value={row.displayName} onChange={e => updateTemplateRow(idx, 'displayName', e.target.value)} />
                        </div>
                        <div>
                          <div style={labelStyle}>Make</div>
                          <input style={inputStyle} value={row.make} onChange={e => updateTemplateRow(idx, 'make', e.target.value)} />
                        </div>
                        <div>
                          <div style={labelStyle}>Model</div>
                          <input style={inputStyle} value={row.model} onChange={e => updateTemplateRow(idx, 'model', e.target.value)} />
                        </div>
                        <div>
                          <div style={labelStyle}>Year</div>
                          <input style={inputStyle} value={row.year} onChange={e => updateTemplateRow(idx, 'year', e.target.value)} />
                        </div>
                        <div>
                          <div style={labelStyle}>Wheelbase</div>
                          <input style={inputStyle} value={row.wheelbase} onChange={e => updateTemplateRow(idx, 'wheelbase', e.target.value)} placeholder="e.g. 148" />
                        </div>
                        <div>
                          <div style={labelStyle}>Doors</div>
                          <select style={inputStyle} value={row.doors} onChange={e => updateTemplateRow(idx, 'doors', e.target.value)}>
                            <option value="">—</option>
                            <option>2-door</option>
                            <option>3-door</option>
                            <option>4-door</option>
                            <option>Sliding door</option>
                            <option>Swing door</option>
                          </select>
                        </div>
                        <div>
                          <div style={labelStyle}>Roof</div>
                          <select style={inputStyle} value={row.roofHeight} onChange={e => updateTemplateRow(idx, 'roofHeight', e.target.value)}>
                            <option value="">—</option>
                            <option>Low</option>
                            <option>Mid</option>
                            <option>High</option>
                            <option>Extended High</option>
                          </select>
                        </div>
                        <div>
                          <div style={labelStyle}>Windows</div>
                          <select style={inputStyle} value={row.windows} onChange={e => updateTemplateRow(idx, 'windows', e.target.value)}>
                            <option value="">—</option>
                            <option>No windows</option>
                            <option>Rear windows</option>
                            <option>Full windows</option>
                            <option>Half windows</option>
                          </select>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}

          {/* Upload button */}
          <button
            onClick={handleUploadTemplates}
            disabled={uploading || selectedTemplateCount === 0}
            style={{
              width: '100%', padding: '14px', borderRadius: '14px', marginTop: '8px',
              background: 'var(--orange)', color: '#fff', fontWeight: 800, fontSize: '15px',
              border: 'none', opacity: uploading || selectedTemplateCount === 0 ? 0.5 : 1,
              boxShadow: '0 4px 16px rgba(238,49,32,0.3)',
            }}
          >
            {uploading ? (uploadNote || 'Uploading...') : `Upload ${selectedTemplateCount} Template${selectedTemplateCount !== 1 ? 's' : ''}`}
          </button>
        </div>
      )}

      {/* ═══════════ PROOF REVIEW ═══════════ */}
      {tab === 'proofs' && proofRows.length > 0 && !uploadResult && (
        <div>
          {/* Sticky customer picker */}
          <div style={{
            padding: '10px 14px', borderRadius: '10px', marginBottom: '10px',
            background: 'var(--card)', border: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
          }}>
            <div style={{ ...labelStyle, flex: '0 0 auto' }}>Customer</div>
            <select
              value={stickyCustomer}
              onChange={e => applyStickyCustomerToAll(e.target.value)}
              style={{ ...inputStyle, flex: 1, minWidth: '200px', fontSize: '12px' }}
            >
              <option value="">— None (use folder structure) —</option>
              {customerOptions.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            {stickyCustomer && (
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', flex: '1 1 100%' }}>
                Sticky — applied to all proofs that haven't been overridden individually.
              </div>
            )}
          </div>

          {/* Summary bar */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '10px 14px', borderRadius: '10px', marginBottom: '12px',
            background: unmatchedProofCount > 0 ? 'var(--warning-bg)' : 'rgba(59,130,246,0.06)',
            border: `1px solid ${unmatchedProofCount > 0 ? 'var(--warning-border)' : 'rgba(59,130,246,0.15)'}`,
          }}>
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: unmatchedProofCount > 0 ? 'var(--warning)' : '#60a5fa' }}>
                {selectedProofCount} matched · {unmatchedProofCount} unmatched
              </div>
              {unmatchedProofCount > 0 && (
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
                  Assign a catalog item to unmatched proofs or deselect them
                </div>
              )}
            </div>
          </div>

          {Object.entries(groupedProofs).map(([customer, rows]) => (
            <div key={customer} style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '8px', padding: '6px 10px', background: 'var(--subtle-bg)', borderRadius: '8px' }}>
                {customer} ({rows.length} file{rows.length !== 1 ? 's' : ''})
              </div>

              {rows.map(row => {
                const idx = proofRows.indexOf(row);
                return (
                  <div key={row.path} style={{
                    padding: '10px', marginBottom: '6px', borderRadius: '10px',
                    background: row.include ? 'var(--card)' : 'var(--subtle-bg)',
                    border: `1px solid ${row.include && !row.catalogId ? 'var(--warning-border)' : row.include ? 'var(--border)' : 'transparent'}`,
                    opacity: row.include ? 1 : 0.5,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <input
                        type="checkbox"
                        checked={row.include}
                        onChange={e => updateProofRow(idx, 'include', e.target.checked)}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '12px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {row.name}
                        </div>
                        <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                          {fmt(row.size)} · {row.vehicleType || 'No vehicle type'}
                        </div>
                      </div>
                      {row.include && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '200px' }}>
                          <select
                            value={row.customer}
                            onChange={e => changeRowCustomer(idx, e.target.value)}
                            style={{ ...inputStyle, fontSize: '11px' }}
                            title="Customer (sticky — applies to later proofs until overridden)"
                          >
                            <option value="">— Customer —</option>
                            {customerOptions.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                          <select
                            value={row.catalogId || ''}
                            onChange={e => updateProofRow(idx, 'catalogId', e.target.value || null)}
                            style={{
                              ...inputStyle, fontSize: '11px',
                              borderColor: row.catalogId ? 'var(--success-border)' : 'var(--warning-border)',
                            }}
                          >
                            <option value="">— Select catalog item —</option>
                            {(row.customer
                              ? catalog.filter(c =>
                                  c.end_customer?.toLowerCase() === row.customer.toLowerCase() ||
                                  c.customer?.toLowerCase() === row.customer.toLowerCase()
                                )
                              : catalog
                            ).map(c => (
                              <option key={c.id} value={c.id}>
                                {c.part_number} — {c.end_customer} ({c.vehicle_type})
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}

          {/* Upload button */}
          <button
            onClick={handleUploadProofs}
            disabled={uploading || selectedProofCount === 0}
            style={{
              width: '100%', padding: '14px', borderRadius: '14px', marginTop: '8px',
              background: 'var(--orange)', color: '#fff', fontWeight: 800, fontSize: '15px',
              border: 'none', opacity: uploading || selectedProofCount === 0 ? 0.5 : 1,
              boxShadow: '0 4px 16px rgba(238,49,32,0.3)',
            }}
          >
            {uploading ? (uploadNote || 'Uploading...') : `Upload ${selectedProofCount} Proof${selectedProofCount !== 1 ? 's' : ''}`}
          </button>
        </div>
      )}

      {/* Back + Reset */}
      <div style={{ display: 'flex', gap: '8px', marginTop: '14px' }}>
        {(templateRows.length > 0 || proofRows.length > 0 || uploadResult) && (
          <button
            onClick={() => { setTemplateRows([]); setProofRows([]); setZipPath(null); setUploadResult(null); setError(''); }}
            style={{ flex: 1, padding: '10px', borderRadius: '10px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 700 }}
          >
            Start Over
          </button>
        )}
        <button
          onClick={() => router.push('/more')}
          style={{ flex: 1, padding: '10px', borderRadius: '10px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: '13px', fontWeight: 700 }}
        >
          ← Back
        </button>
      </div>
    </div>
  );
}
