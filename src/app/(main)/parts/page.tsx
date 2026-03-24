'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
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
  const [laborValue, setLaborValue] = useState('');

  useEffect(() => {
    if (!isAdmin && !isSales) { router.push('/home'); return; }
    loadParts();
    loadLastSync();
  }, [isAdmin, isSales]);

  useEffect(() => {
    loadParts();
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
        setSyncMessage(`Synced ${data.synced} parts from NetSuite`);
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

  const filtered = parts.filter(p => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      p.item_number.toLowerCase().includes(s) ||
      p.display_name?.toLowerCase().includes(s) ||
      p.description?.toLowerCase().includes(s)
    );
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
            {syncing ? '⏳ Syncing...' : '🔄 Sync Now'}
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
          { id: 'upfit' as const, label: '🔧 Upfit Parts', desc: 'Fleet & install' },
          { id: 'graphics' as const, label: '🎨 Graphic Parts', desc: 'Decals & wraps' },
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
          <div style={{ fontSize: '28px', marginBottom: '8px' }}>{catalog === 'upfit' ? '🔧' : '🎨'}</div>
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
            display: 'grid', gridTemplateColumns: '1fr 70px 60px',
            padding: '6px 12px', fontSize: '9px', fontWeight: 700,
            color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.3px',
          }}>
            <div>Part</div>
            <div style={{ textAlign: 'right' }}>Sale $</div>
            <div style={{ textAlign: 'right' }}>Qty</div>
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
                  onClick={() => setExpandedId(isExpanded ? null : part.id)}
                  style={{
                    display: 'grid', gridTemplateColumns: '1fr 70px 60px',
                    padding: '10px 12px', cursor: 'pointer', alignItems: 'center',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {part.item_number}
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
                            {isAdmin && <span style={{ fontSize: '9px', color: 'var(--text-muted)', marginLeft: '4px' }}>✏️</span>}
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
