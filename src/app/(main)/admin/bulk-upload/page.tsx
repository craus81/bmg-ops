'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
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
}

type Tab = 'templates' | 'proofs';

export default function BulkUploadPage() {
  const router = useRouter();
  const { isAdmin, user } = useAuth();
  const supabase = createClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [tab, setTab] = useState<Tab>('templates');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // ZIP file state
  const [zipFile, setZipFile] = useState<File | null>(null);

  // Template state
  const [templateRows, setTemplateRows] = useState<TemplateRow[]>([]);

  // Proof state
  const [proofRows, setProofRows] = useState<ProofRow[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<any>(null);

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    // Load catalog for proof matching
    const loadCatalog = async () => {
      const { data } = await supabase.from('catalog').select('*').order('part_number');
      setCatalog((data as CatalogItem[]) || []);
    };
    loadCatalog();
  }, [isAdmin]);

  const handleZipSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setZipFile(file);
    setError('');
    setUploadResult(null);
    setLoading(true);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch(`/api/admin/upload-zip?type=${tab}`, {
        method: 'POST',
        body: formData,
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
          const customer = f.suggested.customer || '';
          const vehicleType = f.suggested.vehicle_type || '';
          // Try to find a matching catalog item
          const match = catalog.find(c =>
            c.end_customer?.toLowerCase() === customer.toLowerCase() ||
            c.customer?.toLowerCase() === customer.toLowerCase()
          );
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

  const handleUploadTemplates = async () => {
    if (!zipFile) return;
    setUploading(true);
    setError('');

    try {
      const formData = new FormData();
      formData.append('file', zipFile);
      formData.append('manifest', JSON.stringify(templateRows.map(r => ({
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
        include: r.include,
      }))));

      const res = await fetch('/api/admin/bulk-upload-templates', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setUploadResult(data);
    } catch (err: any) {
      setError(err.message || 'Upload failed');
    }
    setUploading(false);
  };

  const handleUploadProofs = async () => {
    if (!zipFile) return;
    setUploading(true);
    setError('');

    try {
      const formData = new FormData();
      formData.append('file', zipFile);
      formData.append('manifest', JSON.stringify(proofRows.map(r => ({
        path: r.path,
        name: r.name,
        catalogId: r.catalogId,
        customer: r.customer,
        vehicleType: r.vehicleType,
        include: r.include,
      }))));

      const res = await fetch('/api/admin/bulk-upload-proofs', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setUploadResult(data);
    } catch (err: any) {
      setError(err.message || 'Upload failed');
    }
    setUploading(false);
  };

  const updateTemplateRow = (index: number, field: keyof TemplateRow, value: any) => {
    setTemplateRows(prev => prev.map((r, i) => i === index ? { ...r, [field]: value } : r));
  };

  const updateProofRow = (index: number, field: keyof ProofRow, value: any) => {
    setProofRows(prev => prev.map((r, i) => i === index ? { ...r, [field]: value } : r));
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
        <div style={{ color: 'var(--text-muted)', marginTop: '12px', fontSize: '13px', fontWeight: 600 }}>Processing ZIP file...</div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: '22px', fontWeight: 800, marginBottom: '16px' }}>Bulk Upload</div>

      {/* Tab Bar */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '14px', background: 'var(--card)', borderRadius: '10px', padding: '3px' }}>
        <button onClick={() => { setTab('templates'); setTemplateRows([]); setProofRows([]); setZipFile(null); setUploadResult(null); setError(''); }} style={{ flex: 1, padding: '10px', borderRadius: '8px', fontSize: '13px', fontWeight: 700, background: tab === 'templates' ? 'var(--tab-active-bg)' : 'transparent', border: 'none', color: tab === 'templates' ? 'var(--text-primary)' : 'var(--text-muted)' }}>
          Vehicle Templates
        </button>
        <button onClick={() => { setTab('proofs'); setTemplateRows([]); setProofRows([]); setZipFile(null); setUploadResult(null); setError(''); }} style={{ flex: 1, padding: '10px', borderRadius: '8px', fontSize: '13px', fontWeight: 700, background: tab === 'proofs' ? 'var(--tab-active-bg)' : 'transparent', border: 'none', color: tab === 'proofs' ? 'var(--text-primary)' : 'var(--text-muted)' }}>
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
          <button
            onClick={() => fileRef.current?.click()}
            style={{
              width: '100%', padding: '40px 20px', borderRadius: '14px',
              border: '2px dashed var(--border)', background: 'var(--card)',
              color: 'var(--text-secondary)', fontSize: '15px', fontWeight: 700,
              cursor: 'pointer', textAlign: 'center',
            }}
          >
            📦 Select ZIP File
          </button>
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
                📁 {group} ({rows.length} file{rows.length !== 1 ? 's' : ''})
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
            {uploading ? 'Uploading...' : `Upload ${selectedTemplateCount} Template${selectedTemplateCount !== 1 ? 's' : ''}`}
          </button>
        </div>
      )}

      {/* ═══════════ PROOF REVIEW ═══════════ */}
      {tab === 'proofs' && proofRows.length > 0 && !uploadResult && (
        <div>
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
                👤 {customer} ({rows.length} file{rows.length !== 1 ? 's' : ''})
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
                        <select
                          value={row.catalogId || ''}
                          onChange={e => updateProofRow(idx, 'catalogId', e.target.value || null)}
                          style={{
                            ...inputStyle, width: 'auto', minWidth: '180px',
                            borderColor: row.catalogId ? 'var(--success-border)' : 'var(--warning-border)',
                          }}
                        >
                          <option value="">— Select catalog item —</option>
                          {catalog.map(c => (
                            <option key={c.id} value={c.id}>
                              {c.part_number} — {c.end_customer} ({c.vehicle_type})
                            </option>
                          ))}
                        </select>
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
            {uploading ? 'Uploading...' : `Upload ${selectedProofCount} Proof${selectedProofCount !== 1 ? 's' : ''}`}
          </button>
        </div>
      )}

      {/* Back + Reset */}
      <div style={{ display: 'flex', gap: '8px', marginTop: '14px' }}>
        {(templateRows.length > 0 || proofRows.length > 0 || uploadResult) && (
          <button
            onClick={() => { setTemplateRows([]); setProofRows([]); setZipFile(null); setUploadResult(null); setError(''); }}
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
