'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import SwipeToDelete from '@/components/SwipeToDelete';
import type { CatalogItem } from '@/lib/types';

export default function CatalogPage() {
  const router = useRouter();
  const { isAdmin } = useAuth();
  const supabase = createClient();
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [importStatus, setImportStatus] = useState<{ total: number; imported: number; skipped: number; errors: string[] } | null>(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState({
    part_number: '', customer: '', end_customer: '',
    vehicle_type: '', graphic_package: '', price: '', proof_pages: '1',
  });

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    const load = async () => {
      const { data } = await supabase.from('catalog').select('*').order('part_number');
      setCatalog((data as CatalogItem[]) || []);
      setLoading(false);
    };
    load();
  }, [isAdmin]);

  // CSV Import
  const handleCSVUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportStatus(null);

    const text = await file.text();
    const lines = text.split('\n').filter((l) => l.trim());
    if (lines.length < 2) {
      setImportStatus({ total: 0, imported: 0, skipped: 0, errors: ['No data rows found'] });
      setImporting(false);
      return;
    }

    // Parse headers
    const headers = parseCSVRow(lines[0]).map((h) => h.trim().toLowerCase());
    const colMap = {
      part_number: headers.findIndex((h) => h === 'itemid' || h === 'item id' || h === 'part_number' || h === 'part number' || h === 'externalid'),
      display_name: headers.findIndex((h) => h === 'display name' || h === 'displayname' || h === 'name' || h === 'description' || h === 'graphic_package'),
      price: headers.findIndex((h) => h === 'base price' || h === 'baseprice' || h === 'price' || h === 'rate'),
    };

    if (colMap.part_number === -1) {
      setImportStatus({ total: 0, imported: 0, skipped: 0, errors: ['Could not find part number column (Itemid, Part_Number, or Externalid)'] });
      setImporting(false);
      return;
    }

    // Get existing part numbers to skip duplicates
    const existing = new Set(catalog.map((c) => c.part_number.toUpperCase()));
    const toInsert: any[] = [];
    const skipped: string[] = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVRow(lines[i]);
      const partNum = cols[colMap.part_number]?.trim();
      if (!partNum) continue;

      if (existing.has(partNum.toUpperCase())) {
        skipped.push(partNum);
        continue;
      }

      existing.add(partNum.toUpperCase()); // prevent dupes within the file

      const displayName = colMap.display_name !== -1 ? cols[colMap.display_name]?.trim() || '' : '';
      const price = colMap.price !== -1 ? parseFloat(cols[colMap.price]?.replace(/[^0-9.]/g, '') || '0') || 0 : 0;

      toInsert.push({
        part_number: partNum,
        customer: '',
        end_customer: '',
        vehicle_type: '',
        graphic_package: displayName,
        price: price,
        proof_pages: 1,
      });
    }

    // Insert in batches of 50
    let imported = 0;
    const errors: string[] = [];
    for (let i = 0; i < toInsert.length; i += 50) {
      const batch = toInsert.slice(i, i + 50);
      const { data, error } = await supabase.from('catalog').insert(batch).select();
      if (error) {
        errors.push(`Batch ${Math.floor(i / 50) + 1}: ${error.message}`);
      } else {
        imported += (data as any[])?.length || 0;
        setCatalog((prev) => [...prev, ...((data as CatalogItem[]) || [])].sort((a, b) => a.part_number.localeCompare(b.part_number)));
      }
    }

    setImportStatus({
      total: toInsert.length + skipped.length,
      imported,
      skipped: skipped.length,
      errors,
    });
    setImporting(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleAdd = async () => {
    if (!form.part_number) return;
    const { data, error } = await supabase
      .from('catalog')
      .insert({
        part_number: form.part_number, customer: form.customer || '',
        end_customer: form.end_customer || '', vehicle_type: form.vehicle_type || '',
        graphic_package: form.graphic_package || '', price: Number(form.price) || 0,
        proof_pages: Number(form.proof_pages) || 1,
      })
      .select()
      .single();

    if (data && !error) {
      setCatalog((prev) => [...prev, data as CatalogItem].sort((a, b) => a.part_number.localeCompare(b.part_number)));
      resetForm();
      setShowAdd(false);
    }
  };

  const handleDelete = async (id: string) => {
    const { error } = await supabase.from('catalog').delete().eq('id', id);
    if (!error) {
      setCatalog((prev) => prev.filter((c) => c.id !== id));
    }
  };

  const startEdit = (c: CatalogItem) => {
    setEditId(c.id);
    setForm({
      part_number: c.part_number,
      customer: c.customer || '',
      end_customer: c.end_customer || '',
      vehicle_type: c.vehicle_type || '',
      graphic_package: c.graphic_package || '',
      price: c.price.toString(),
      proof_pages: c.proof_pages.toString(),
    });
  };

  const saveEdit = async () => {
    if (!editId) return;
    const { error } = await supabase
      .from('catalog')
      .update({
        part_number: form.part_number, customer: form.customer || '',
        end_customer: form.end_customer || '', vehicle_type: form.vehicle_type || '',
        graphic_package: form.graphic_package || '', price: Number(form.price) || 0,
        proof_pages: Number(form.proof_pages) || 1,
      })
      .eq('id', editId);

    if (!error) {
      setCatalog((prev) =>
        prev.map((c) =>
          c.id === editId
            ? { ...c, part_number: form.part_number, customer: form.customer || '', end_customer: form.end_customer || '', vehicle_type: form.vehicle_type || '', graphic_package: form.graphic_package || '', price: Number(form.price) || 0, proof_pages: Number(form.proof_pages) || 1 }
            : c
        ).sort((a, b) => a.part_number.localeCompare(b.part_number))
      );
      setEditId(null);
      resetForm();
    }
  };

  const resetForm = () => {
    setForm({ part_number: '', customer: '', end_customer: '', vehicle_type: '', graphic_package: '', price: '', proof_pages: '1' });
  };

  const cancelEdit = () => {
    setEditId(null);
    resetForm();
  };

  const filtered = search
    ? catalog.filter((c) => {
        const s = search.toLowerCase();
        return c.part_number.toLowerCase().includes(s) || c.graphic_package?.toLowerCase().includes(s) || c.end_customer?.toLowerCase().includes(s) || c.customer?.toLowerCase().includes(s);
      })
    : catalog;

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: '#4a5f78' }}>Loading...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Part Catalog ({catalog.length})
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button onClick={() => { setShowImport(!showImport); setShowAdd(false); }} style={{ padding: '6px 12px', borderRadius: '8px', background: showImport ? '#1e2d3d' : 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.25)', color: '#60a5fa', fontSize: '12px', fontWeight: 700 }}>
            {showImport ? 'Cancel' : '📤 Import'}
          </button>
          <button onClick={() => { setShowAdd(!showAdd); setShowImport(false); setEditId(null); resetForm(); }} style={{ padding: '6px 12px', borderRadius: '8px', background: '#3b82f6', color: '#fff', fontSize: '12px', fontWeight: 700, border: 'none' }}>
            {showAdd ? 'Cancel' : '+ Add'}
          </button>
        </div>
      </div>

      {/* CSV Import Panel */}
      {showImport && (
        <div style={{ background: '#141e2b', border: '1px solid #1e2d3d', borderRadius: '10px', padding: '14px', marginBottom: '12px' }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: '#e8ecf1', marginBottom: '6px' }}>Import from CSV</div>
          <div style={{ fontSize: '11px', color: '#4a5f78', marginBottom: '10px' }}>
            Upload a CSV with columns: Itemid (part number), Display Name (description), Base Price. Duplicates will be skipped.
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            onChange={handleCSVUpload}
            disabled={importing}
            style={{ fontSize: '13px', color: '#e8ecf1' }}
          />
          {importing && (
            <div style={{ marginTop: '10px', fontSize: '13px', color: '#60a5fa' }}>
              Importing...
            </div>
          )}
          {importStatus && (
            <div style={{ marginTop: '10px', padding: '10px', background: importStatus.errors.length > 0 ? 'rgba(239,68,68,0.06)' : 'rgba(34,197,94,0.06)', border: `1px solid ${importStatus.errors.length > 0 ? 'rgba(239,68,68,0.2)' : 'rgba(34,197,94,0.2)'}`, borderRadius: '8px' }}>
              <div style={{ fontSize: '13px', fontWeight: 700, color: importStatus.errors.length > 0 ? '#f87171' : '#4ade80' }}>
                {importStatus.imported} imported, {importStatus.skipped} skipped (duplicate)
              </div>
              {importStatus.errors.length > 0 && (
                <div style={{ fontSize: '11px', color: '#f87171', marginTop: '4px' }}>
                  {importStatus.errors.map((e, i) => <div key={i}>{e}</div>)}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Search */}
      <div style={{ marginBottom: '10px' }}>
        <input
          placeholder="Search parts..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ ...inputStyle, padding: '10px 14px', fontSize: '14px' }}
        />
      </div>

      {/* Add form */}
      {showAdd && (
        <div style={{ background: '#141e2b', border: '1px solid #1e2d3d', borderRadius: '10px', padding: '14px', marginBottom: '12px' }}>
          <Input label="Part Number" value={form.part_number} onChange={(v) => setForm({ ...form, part_number: v })} />
          <Input label="Description" value={form.graphic_package} onChange={(v) => setForm({ ...form, graphic_package: v })} />
          <Input label="Price" value={form.price} onChange={(v) => setForm({ ...form, price: v })} type="number" />
          <Input label="Proof Pages" value={form.proof_pages} onChange={(v) => setForm({ ...form, proof_pages: v })} type="number" />
          <Input label="Customer" value={form.customer} onChange={(v) => setForm({ ...form, customer: v })} />
          <Input label="End Customer" value={form.end_customer} onChange={(v) => setForm({ ...form, end_customer: v })} />
          <Input label="Vehicle Type" value={form.vehicle_type} onChange={(v) => setForm({ ...form, vehicle_type: v })} />
          <button onClick={handleAdd} style={{ width: '100%', marginTop: '12px', padding: '12px', borderRadius: '10px', background: '#22c55e', color: '#fff', fontWeight: 800, fontSize: '14px', border: 'none' }}>
            Save Part Number
          </button>
        </div>
      )}

      {/* Results count when searching */}
      {search && (
        <div style={{ fontSize: '11px', color: '#4a5f78', marginBottom: '6px' }}>
          Showing {filtered.length} of {catalog.length}
        </div>
      )}

      {/* Part list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
        {filtered.map((c) => {
          const isEditing = editId === c.id;

          return (
            <SwipeToDelete
              key={c.id}
              onDelete={() => handleDelete(c.id)}
              confirmMessage={`Delete part ${c.part_number}? This cannot be undone.`}
            >
              <div style={{ background: '#141e2b', border: '1px solid #1e2d3d', borderRadius: '10px', padding: '12px' }}>
                {isEditing ? (
                  <div>
                    <Input label="Part Number" value={form.part_number} onChange={(v) => setForm({ ...form, part_number: v })} />
                    <Input label="Description" value={form.graphic_package} onChange={(v) => setForm({ ...form, graphic_package: v })} />
                    <Input label="Price" value={form.price} onChange={(v) => setForm({ ...form, price: v })} type="number" />
                    <Input label="Proof Pages" value={form.proof_pages} onChange={(v) => setForm({ ...form, proof_pages: v })} type="number" />
                    <Input label="Customer" value={form.customer} onChange={(v) => setForm({ ...form, customer: v })} />
                    <Input label="End Customer" value={form.end_customer} onChange={(v) => setForm({ ...form, end_customer: v })} />
                    <Input label="Vehicle Type" value={form.vehicle_type} onChange={(v) => setForm({ ...form, vehicle_type: v })} />
                    <div style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
                      <button onClick={saveEdit} style={{ flex: 1, padding: '10px', borderRadius: '8px', background: '#22c55e', color: '#fff', fontSize: '12px', fontWeight: 700, border: 'none' }}>
                        Save
                      </button>
                      <button onClick={cancelEdit} style={{ flex: 1, padding: '10px', borderRadius: '8px', background: 'transparent', border: '1px solid #1e2d3d', color: '#6b7a8d', fontSize: '12px', fontWeight: 700 }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div onClick={() => startEdit(c)} style={{ display: 'flex', justifyContent: 'space-between', cursor: 'pointer' }}>
                    <div>
                      <div style={{ fontWeight: 800, fontSize: '15px' }}>{c.part_number}</div>
                      <div style={{ fontSize: '12px', color: '#93c5fd', marginTop: '1px' }}>{c.graphic_package || '—'}</div>
                      {(c.customer || c.end_customer || c.vehicle_type) && (
                        <div style={{ fontSize: '11px', color: '#4a5f78' }}>
                          {[c.end_customer, c.vehicle_type, c.customer].filter(Boolean).join(' • ')}
                        </div>
                      )}
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontWeight: 800, fontSize: '15px', color: '#4ade80' }}>${c.price.toFixed(2)}</div>
                      <div style={{ fontSize: '10px', color: '#3b82f6', marginTop: '2px' }}>tap to edit</div>
                    </div>
                  </div>
                )}
              </div>
            </SwipeToDelete>
          );
        })}
      </div>

      <button onClick={() => router.push('/more')} style={{ width: '100%', padding: '10px', borderRadius: '10px', marginTop: '14px', border: '1px solid #1e2d3d', background: 'transparent', color: '#6b7a8d', fontSize: '13px', fontWeight: 700 }}>
        ← Back
      </button>
    </div>
  );
}

// Parse a CSV row handling quoted fields with commas
function parseCSVRow(row: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

const labelStyle: React.CSSProperties = { display: 'block', fontSize: '10px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' };
const inputStyle: React.CSSProperties = { width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #1e2d3d', background: '#0f1720', color: '#e8ecf1', fontSize: '13px' };

function Input({ label, value, onChange, type }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div style={{ marginTop: '8px' }}>
      <label style={labelStyle}>{label}</label>
      <input type={type || 'text'} value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle} />
    </div>
  );
}
