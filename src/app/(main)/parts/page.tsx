'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { storage } from '@/lib/storage';
import { useAuth } from '@/components/AuthProvider';

interface Part {
  id: string;
  netsuite_id: string;
  item_number: string;
  display_name: string | null;
  description: string | null;
  item_type: string | null;
  catalog: 'upfit' | 'graphics';
  sales_price: number;
  purchase_price: number;
  quantity_on_hand: number;
  quantity_available: number;
  labor_hours: number;
  ns_class: string | null;
  ns_department: string | null;
  vendor: string | null;
  billable_customer: string | null;
  requires_po_match: boolean;
  is_active: boolean;
  last_synced_at: string;
}

interface SyncLog {
  id: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  parts_synced: number;
  error: string | null;
}

export default function PartsPage() {
  const router = useRouter();
  const { user, isAdmin, isSales } = useAuth();
  const supabase = createClient();

  const [parts, setParts] = useState<Part[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState<'upfit' | 'graphics'>('upfit');
  const [search, setSearch] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  const [lastSync, setLastSync] = useState<SyncLog | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingLabor, setEditingLabor] = useState<string | null>(null);
  const [sortCol, setSortCol] = useState<'item_number' | 'sales_price' | 'quantity_on_hand' | 'labor_hours'>('item_number');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [laborValue, setLaborValue] = useState('');

  // Billable customer editing
  const [editingCustomer, setEditingCustomer] = useState<string | null>(null);
  const [customerValue, setCustomerValue] = useState('');

  // Part files
  interface PartFile { id: string; part_id: string; file_name: string; file_type: string | null; file_size: number | null; storage_path: string; }
  const [partFiles, setPartFiles] = useState<Record<string, PartFile[]>>({});
  const [uploadingFile, setUploadingFile] = useState(false);
  const partFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isAdmin && !isSales) { router.push('/home'); return; }
    loadParts();
    loadLastSync();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [isAdmin, isSales]);

  useEffect(() => {
    loadParts();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [catalog]);

  const loadParts = async () => {
    setLoading(true);
    // Supabase returns max 1000 rows by default — paginate to get all
    let allParts: Part[] = [];
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;
    while (hasMore) {
      const from = page * pageSize;
      const to = from + pageSize - 1;
      const { data } = await supabase
        .from('netsuite_parts')
        .select('*')
        .eq('catalog', catalog)
        .eq('is_active', true)
        .order('item_number', { ascending: true })
        .range(from, to);
      const batch = (data || []) as Part[];
      allParts = allParts.concat(batch);
      hasMore = batch.length === pageSize;
      page++;
    }
    setParts(allParts);
    setLoading(false);
  };

  const loadLastSync = async () => {
    const { data } = await supabase
      .from('parts_sync_log')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(1)
      .single();
    if (data) setLastSync(data as SyncLog);
  };

  const handleSync = async () => {
    setSyncing(true);
    setSyncMessage('Syncing parts from NetSuite...');

    try {
      const res = await fetch('/api/parts/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user?.id }),
      });

      const data = await res.json();

      if (!res.ok) {
        setSyncMessage(`Sync failed: ${data.error || 'Unknown error'}`);
      } else {
        const details = [
          `${data.synced} parts synced`,
          data.itemsWithPrice ? `${data.itemsWithPrice} with price` : null,
          data.itemsWithQty ? `${data.itemsWithQty} with qty` : null,
        ].filter(Boolean).join(', ');
        setSyncMessage(details);
        loadParts();
        loadLastSync();
      }
    } catch (err: any) {
      setSyncMessage(`Sync error: ${err.message}`);
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMessage(''), 5000);
    }
  };

  const updateLaborHours = async (partId: string) => {
    const hours = parseFloat(laborValue);
    if (isNaN(hours) || hours < 0) return;

    await supabase
      .from('netsuite_parts')
      .update({ labor_hours: hours, updated_at: new Date().toISOString() })
      .eq('id', partId);

    setEditingLabor(null);
    setLaborValue('');
    loadParts();
  };

  const updateBillableCustomer = async (partId: string) => {
    await supabase.from('netsuite_parts').update({ billable_customer: customerValue.trim() || null }).eq('id', partId);
    setParts(prev => prev.map(p => p.id === partId ? { ...p, billable_customer: customerValue.trim() || null } : p));
    setEditingCustomer(null);
    setCustomerValue('');
  };

  const loadPartFiles = async (partId: string) => {
    const { data } = await supabase.from('part_files').select('*').eq('part_id', partId).order('uploaded_at', { ascending: false });
    if (data) setPartFiles(prev => ({ ...prev, [partId]: data as PartFile[] }));
  };

  const uploadPartFile = async (partId: string, file: File) => {
    setUploadingFile(true);
    const ext = file.name.split('.').pop() || 'bin';
    const path = `part-files/${partId}/${Date.now()}.${ext}`;
    const { error: upErr } = await storage.from('graphics-proofs').upload(path, file, { contentType: file.type });
    if (!upErr) {
      await supabase.from('part_files').insert({ part_id: partId, file_name: file.name, file_type: file.type || null, file_size: file.size, storage_path: path, uploaded_by: user?.id });
      await loadPartFiles(partId);
    }
    setUploadingFile(false);
  };

  const deletePartFile = async (file: PartFile) => {
    if (!window.confirm(`Delete "${file.file_name}"?`)) return;
    await storage.from('graphics-proofs').remove([file.storage_path]);
    await supabase.from('part_files').delete().eq('id', file.id);
    setPartFiles(prev => ({ ...prev, [file.part_id]: (prev[file.part_id] || []).filter(f => f.id !== file.id) }));
  };

  const getFileUrl = (path: string) => storage.from('graphics-proofs').getPublicUrl(path).data.publicUrl;

  const toggleSort = (col: typeof sortCol) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };
  const sortIndicator = (col: typeof sortCol) => sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  const filtered = parts.filter(p => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      p.item_number.toLowerCase().includes(s) ||
      p.display_name?.toLowerCase().includes(s) ||
      p.description?.toLowerCase().includes(s)
    );
  }).sort((a, b) => {
    const av = a[sortCol] ?? 0;
    const bv = b[sortCol] ?? 0;
    const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number);
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const formatCurrency = (val: number) => {
    return val ? `$${val.toFixed(2)}` : '$0.00';
  };

  const formatQty = (val: number) => {
    return val % 1 === 0 ? val.toString() : val.toFixed(1);
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: '8px',
    border: '1px solid var(--border)', background: 'var(--input-bg)',
    color: 'var(--text-primary)', fontSize: '12px',
  };

  if (!isAdmin && !isSales) return null;

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '14px' }}>
        <div>
          <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)' }}>Parts Catalog</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
            {parts.length} {catalog} parts {lastSync?.completed_at ? `· Last synced ${new Date(lastSync.completed_at).toLocaleString()}` : ''}
          </div>
        </div>
        {isAdmin && (
          <button
            onClick={handleSync}
            disabled={syncing}
            style={{
              padding: '8px 14px', borderRadius: '10px',
              background: syncing ? 'var(--subtle-bg)' : 'var(--accent)',
              color: '#fff', fontWeight: 800, fontSize: '12px',
              border: 'none', cursor: syncing ? 'not-allowed' : 'pointer',
              opacity: syncing ? 0.6 : 1,
              whiteSpace: 'nowrap',
            }}
          >
            {syncing ? 'Syncing...' : 'Sync Now'}
          </button>
        )}
      </div>

      {/* Sync message */}
      {syncMessage && (
        <div style={{
          padding: '8px 12px', borderRadius: '8px', marginBottom: '10px',
          background: syncMessage.includes('fail') || syncMessage.includes('error')
            ? 'var(--error-bg)' : 'rgba(16,185,129,0.1)',
          border: `1px solid ${syncMessage.includes('fail') || syncMessage.includes('error')
            ? 'var(--error-border)' : 'rgba(16,185,129,0.2)'}`,
          color: syncMessage.includes('fail') || syncMessage.includes('error')
            ? 'var(--error)' : '#34d399',
          fontSize: '12px', fontWeight: 600,
        }}>
          {syncMessage}
        </div>
      )}

      {/* Catalog tabs */}
      <div style={{
        display: 'flex', gap: '4px', padding: '4px',
        background: 'var(--card)', border: '1px solid var(--border)',
        borderRadius: '12px', marginBottom: '10px',
      }}>
        {([
          { id: 'upfit' as const, label: 'Upfit Parts', desc: 'Fleet & install' },
          { id: 'graphics' as const, label: 'Graphic Parts', desc: 'Decals & wraps' },
        ]).map((tab) => (
          <button
            key={tab.id}
            onClick={() => { setCatalog(tab.id); setExpandedId(null); }}
            style={{
              flex: 1, padding: '10px 8px', borderRadius: '10px',
              fontSize: '13px', fontWeight: 700, textAlign: 'center',
              background: catalog === tab.id ? 'var(--tab-active-bg)' : 'transparent',
              border: catalog === tab.id ? '1px solid var(--tab-active-border)' : '1px solid transparent',
              color: catalog === tab.id ? 'var(--text-primary)' : 'var(--text-muted)',
              transition: 'all 0.15s',
            }}
          >
            <div>{tab.label}</div>
            <div style={{ fontSize: '9px', fontWeight: 400, marginTop: '1px', color: 'var(--text-muted)' }}>{tab.desc}</div>
          </button>
        ))}
      </div>

      {/* Search */}
      <input
        placeholder={`Search ${catalog} parts...`}
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{ ...inputStyle, marginBottom: '10px' }}
      />

      {/* Parts list */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading parts...</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '13px', marginBottom: '8px', fontWeight: 700, color: 'var(--text-muted)' }}>—</div>
          <div style={{ fontSize: '13px', fontWeight: 700 }}>
            {parts.length === 0 ? 'No parts synced yet' : 'No matching parts'}
          </div>
          <div style={{ fontSize: '11px', marginTop: '4px' }}>
            {parts.length === 0 ? 'Hit "Sync Now" to pull parts from NetSuite.' : 'Try different search terms.'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {/* Column headers */}
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 70px 50px 50px',
            padding: '6px 12px', fontSize: '9px', fontWeight: 700,
            color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.3px',
          }}>
            <div onClick={() => toggleSort('item_number')} style={{ cursor: 'pointer', color: sortCol === 'item_number' ? '#60a5fa' : undefined }}>Part{sortIndicator('item_number')}</div>
            <div onClick={() => toggleSort('sales_price')} style={{ textAlign: 'right', cursor: 'pointer', color: sortCol === 'sales_price' ? '#60a5fa' : undefined }}>Sale ${sortIndicator('sales_price')}</div>
            <div onClick={() => toggleSort('quantity_on_hand')} style={{ textAlign: 'right', cursor: 'pointer', color: sortCol === 'quantity_on_hand' ? '#60a5fa' : undefined }}>Qty{sortIndicator('quantity_on_hand')}</div>
            <div onClick={() => toggleSort('labor_hours')} style={{ textAlign: 'right', cursor: 'pointer', color: sortCol === 'labor_hours' ? '#60a5fa' : undefined }}>Labor{sortIndicator('labor_hours')}</div>
          </div>

          {filtered.map(part => {
            const isExpanded = expandedId === part.id;
            const isEditingLabor = editingLabor === part.id;
            const margin = part.sales_price > 0 && part.purchase_price > 0
              ? ((part.sales_price - part.purchase_price) / part.sales_price * 100).toFixed(1)
              : null;

            return (
              <div key={part.id} style={{
                borderRadius: '10px',
                background: 'var(--card)', border: '1px solid var(--border)',
                overflow: 'hidden',
              }}>
                {/* Row summary */}
                <div
                  onClick={() => { const newId = isExpanded ? null : part.id; setExpandedId(newId); if (newId) loadPartFiles(newId); }}
                  style={{
                    display: 'grid', gridTemplateColumns: '1fr 70px 50px 50px',
                    padding: '10px 12px', cursor: 'pointer', alignItems: 'center',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {part.item_number}
                      </span>
                      {part.vendor && (
                        <span style={{ fontSize: '8px', fontWeight: 700, padding: '1px 5px', borderRadius: '4px', background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.25)', color: '#a78bfa', whiteSpace: 'nowrap', flexShrink: 0 }}>
                          {part.vendor}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {part.display_name || part.description || '—'}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', fontSize: '12px', fontWeight: 700, color: '#34d399' }}>
                    {formatCurrency(part.sales_price)}
                  </div>
                  <div style={{ textAlign: 'right', fontSize: '12px', fontWeight: 600, color: part.quantity_on_hand > 0 ? 'var(--text-primary)' : 'var(--error)' }}>
                    {formatQty(part.quantity_on_hand)}
                  </div>
                  <div style={{ textAlign: 'right', fontSize: '12px', fontWeight: 600, color: part.labor_hours > 0 ? '#c084fc' : 'var(--text-muted)' }}>
                    {part.labor_hours > 0 ? `${part.labor_hours}h` : '—'}
                  </div>
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div style={{ padding: '0 12px 12px', borderTop: '1px solid var(--border)' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '10px' }}>
                      <DetailField label="Sales Price" value={formatCurrency(part.sales_price)} color="#34d399" />
                      <DetailField label="Purchase Price" value={formatCurrency(part.purchase_price)} color="#60a5fa" />
                      <DetailField label="Qty On Hand" value={formatQty(part.quantity_on_hand)} color={part.quantity_on_hand > 0 ? 'var(--text-primary)' : 'var(--error)'} />
                      <DetailField label="Qty Available" value={formatQty(part.quantity_available)} color={part.quantity_available > 0 ? 'var(--text-primary)' : 'var(--error)'} />
                      {margin && (
                        <DetailField label="Margin" value={`${margin}%`} color={parseFloat(margin) > 30 ? '#34d399' : '#f59e0b'} />
                      )}
                      <div>
                        <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '2px' }}>
                          Labor Hours
                        </div>
                        {isEditingLabor ? (
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <input
                              type="number"
                              step="0.25"
                              min="0"
                              value={laborValue}
                              onChange={e => setLaborValue(e.target.value)}
                              style={{ ...inputStyle, padding: '4px 6px', width: '70px' }}
                              autoFocus
                              onKeyDown={e => { if (e.key === 'Enter') updateLaborHours(part.id); if (e.key === 'Escape') setEditingLabor(null); }}
                            />
                            <button
                              onClick={() => updateLaborHours(part.id)}
                              style={{ padding: '4px 8px', borderRadius: '6px', background: 'var(--accent)', color: '#fff', fontSize: '10px', fontWeight: 700, border: 'none', cursor: 'pointer' }}
                            >
                              Save
                            </button>
                          </div>
                        ) : (
                          <div
                            onClick={() => { if (isAdmin) { setEditingLabor(part.id); setLaborValue(part.labor_hours.toString()); } }}
                            style={{ fontSize: '14px', fontWeight: 700, color: '#c084fc', cursor: isAdmin ? 'pointer' : 'default' }}
                          >
                            {part.labor_hours > 0 ? `${part.labor_hours}h` : '—'}
                            {isAdmin && <span style={{ fontSize: '9px', color: 'var(--text-muted)', marginLeft: '4px' }}>Edit</span>}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Extra info */}
                    <div style={{ marginTop: '10px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      {part.item_type && (
                        <Tag label={part.item_type} />
                      )}
                      {part.ns_class && (
                        <Tag label={part.ns_class} />
                      )}
                      {part.ns_department && (
                        <Tag label={part.ns_department} />
                      )}
                    </div>

                    {part.description && (
                      <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                        {part.description}
                      </div>
                    )}

                    {/* Billable Customer */}
                    {isAdmin && (
                      <div style={{ marginTop: '10px' }}>
                        <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Billable Customer</div>
                        {editingCustomer === part.id ? (
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <input value={customerValue} onChange={e => setCustomerValue(e.target.value)} placeholder="e.g. Masterack" autoFocus
                              onKeyDown={e => { if (e.key === 'Enter') updateBillableCustomer(part.id); if (e.key === 'Escape') setEditingCustomer(null); }}
                              style={{ ...inputStyle, padding: '6px 8px', flex: 1 }} />
                            <button onClick={() => updateBillableCustomer(part.id)} style={{ padding: '6px 10px', borderRadius: '6px', background: '#22c55e', color: '#fff', fontSize: '10px', fontWeight: 700, border: 'none', cursor: 'pointer' }}>Save</button>
                          </div>
                        ) : (
                          <div onClick={() => { setEditingCustomer(part.id); setCustomerValue(part.billable_customer || ''); }}
                            style={{ fontSize: '13px', fontWeight: 700, color: part.billable_customer ? '#a78bfa' : 'var(--text-muted)', cursor: 'pointer' }}>
                            {part.billable_customer || '— Set Customer'}
                            <span style={{ fontSize: '9px', color: 'var(--text-muted)', marginLeft: '4px' }}>Edit</span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Part Files */}
                    <div style={{ marginTop: '10px' }}>
                      <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Files &amp; Proofs</div>
                      {(partFiles[part.id] || []).map(f => (
                        <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 6px', borderRadius: '6px', background: 'var(--subtle-bg)', marginBottom: '3px' }}>
                          <a href={getFileUrl(f.storage_path)} target="_blank" rel="noopener noreferrer"
                            style={{ flex: 1, fontSize: '11px', fontWeight: 600, color: '#60a5fa', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {f.file_name}
                          </a>
                          {isAdmin && (
                            <button onClick={() => deletePartFile(f)} style={{ padding: '2px 6px', borderRadius: '4px', border: 'none', background: 'rgba(248,113,113,0.1)', color: '#f87171', fontSize: '10px', fontWeight: 700, cursor: 'pointer' }}>✕</button>
                          )}
                        </div>
                      ))}
                      {isAdmin && (
                        <>
                          <input ref={partFileRef} type="file" accept="image/*,.pdf,.eps,.ai,.svg" style={{ display: 'none' }}
                            onChange={async (e) => { const f = e.target.files?.[0]; if (f) await uploadPartFile(part.id, f); e.target.value = ''; }} />
                          <button onClick={() => partFileRef.current?.click()} disabled={uploadingFile} style={{
                            width: '100%', padding: '6px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                            background: 'var(--subtle-bg)', border: '1px dashed var(--border)',
                            color: uploadingFile ? 'var(--text-muted)' : 'var(--text-secondary)', cursor: 'pointer',
                          }}>{uploadingFile ? 'Uploading...' : '+ Upload Proof / File'}</button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Part count */}
      {!loading && filtered.length > 0 && (
        <div style={{ textAlign: 'center', padding: '10px', fontSize: '11px', color: 'var(--text-muted)' }}>
          Showing {filtered.length} of {parts.length} {catalog} parts
        </div>
      )}
    </div>
  );
}

function DetailField({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '2px' }}>
        {label}
      </div>
      <div style={{ fontSize: '14px', fontWeight: 700, color }}>
        {value}
      </div>
    </div>
  );
}

function Tag({ label }: { label: string }) {
  return (
    <span style={{
      padding: '2px 8px', borderRadius: '4px',
      background: 'var(--subtle-bg)', border: '1px solid var(--border)',
      color: 'var(--text-muted)', fontSize: '9px', fontWeight: 700,
    }}>
      {label}
    </span>
  );
}
