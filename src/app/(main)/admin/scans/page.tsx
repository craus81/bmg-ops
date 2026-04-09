'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';

interface ScanLog {
  id: string;
  vin: string;
  vehicle_year: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  part_number: string | null;
  part_description: string | null;
  billable_customer: string | null;
  location_name: string | null;
  po_id: string | null;
  po_number: string | null;
  po_line_item_id: string | null;
  scanned_by: string | null;
  scanned_at: string;
  exported_at: string | null;
  archived_at: string | null;
  requires_po?: boolean;
}

type ViewTab = 'ready' | 'waiting' | 'exported' | 'archived';

export default function AdminScansPage() {
  const { user } = useAuth();
  const supabase = createClient();

  const [scans, setScans] = useState<ScanLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<ViewTab>('ready');
  const [search, setSearch] = useState('');
  const [profiles, setProfiles] = useState<Record<string, string>>({});
  const [selectedScans, setSelectedScans] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [matching, setMatching] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  // Part requires_po_match lookup
  const [poRequired, setPoRequired] = useState<Record<string, boolean>>({});

  useEffect(() => { loadAll(); }, []);

  const loadAll = async () => {
    setLoading(true);
    const [scansRes, profilesRes, partsRes] = await Promise.all([
      supabase.from('scan_logs').select('*').is('archived_at', null).order('scanned_at', { ascending: false }).limit(1000),
      supabase.from('profiles').select('id, full_name'),
      supabase.from('netsuite_parts').select('item_number, requires_po_match'),
    ]);

    setScans((scansRes.data || []) as ScanLog[]);

    const pMap: Record<string, string> = {};
    (profilesRes.data || []).forEach((p: any) => { pMap[p.id] = p.full_name; });
    setProfiles(pMap);

    const poMap: Record<string, boolean> = {};
    (partsRes.data || []).forEach((p: any) => { poMap[p.item_number] = p.requires_po_match !== false; });
    setPoRequired(poMap);

    setSelectedScans(new Set());
    setLoading(false);
  };

  const needsPO = (scan: ScanLog) => poRequired[scan.part_number || ''] !== false;

  // Categorize scans
  const pending = scans.filter(s => !s.exported_at);
  const readyToExport = pending.filter(s => s.po_id || !needsPO(s));
  const waitingForPO = pending.filter(s => !s.po_id && needsPO(s));
  const exported = scans.filter(s => s.exported_at);

  const getTabScans = () => {
    if (tab === 'ready') return readyToExport;
    if (tab === 'waiting') return waitingForPO;
    if (tab === 'exported') return exported;
    return [];
  };

  const tabScans = getTabScans().filter(s => {
    if (!search) return true;
    const q = search.toLowerCase();
    return s.vin.toLowerCase().includes(q) ||
      s.part_number?.toLowerCase().includes(q) ||
      s.billable_customer?.toLowerCase().includes(q) ||
      s.location_name?.toLowerCase().includes(q) ||
      s.po_number?.toLowerCase().includes(q) ||
      [s.vehicle_year, s.vehicle_make, s.vehicle_model].filter(Boolean).join(' ').toLowerCase().includes(q);
  });

  // Group by billable customer → part + location
  const grouped = tabScans.reduce((acc: Record<string, Record<string, ScanLog[]>>, s) => {
    const customer = s.billable_customer || 'No Customer';
    const subKey = `${s.part_number || 'No Part'} · ${s.location_name || 'No Location'}`;
    if (!acc[customer]) acc[customer] = {};
    if (!acc[customer][subKey]) acc[customer][subKey] = [];
    acc[customer][subKey].push(s);
    return acc;
  }, {});
  const customerKeys = Object.keys(grouped).sort((a, b) => a === 'No Customer' ? 1 : b === 'No Customer' ? -1 : a.localeCompare(b));

  const toggleGroup = (key: string) => {
    setCollapsedGroups(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  };

  const toggleSelect = (id: string) => {
    setSelectedScans(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  const selectAllVisible = () => {
    if (selectedScans.size === tabScans.length) setSelectedScans(new Set());
    else setSelectedScans(new Set(tabScans.map(s => s.id)));
  };

  // Trigger retroactive PO matching
  const runAutoMatch = async () => {
    setMatching(true);
    try {
      const res = await fetch('/api/scans/match-po', { method: 'POST' });
      const data = await res.json();
      alert(`Matched ${data.matched} of ${data.total} unmatched scans`);
      await loadAll();
    } catch {
      alert('Match failed');
    }
    setMatching(false);
  };

  // Export to CSV
  const exportCSV = async () => {
    const toExport = tabScans.filter(s => selectedScans.has(s.id));
    if (toExport.length === 0) return;
    setExporting(true);

    const headers = ['VIN', 'Year', 'Make', 'Model', 'Part Number', 'Description', 'Billable Customer', 'Location', 'PO Number', 'Scanned By', 'Date'];
    const rows = toExport.map(s => [
      s.vin, s.vehicle_year || '', s.vehicle_make || '', s.vehicle_model || '',
      s.part_number || '', s.part_description || '', s.billable_customer || '',
      s.location_name || '', s.po_number || '',
      profiles[s.scanned_by || ''] || '', new Date(s.scanned_at).toLocaleString(),
    ]);

    const csv = [headers, ...rows].map(r => r.map(c => `"${(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scans-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    await supabase.from('scan_logs').update({ exported_at: new Date().toISOString(), exported_by: user?.id }).in('id', toExport.map(s => s.id));
    setExporting(false);
    loadAll();
  };

  const archiveExported = async () => {
    const ids = [...selectedScans];
    if (ids.length === 0) return;
    await supabase.from('scan_logs').update({ archived_at: new Date().toISOString() }).in('id', ids);
    loadAll();
  };

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>;

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px' }}>
        Scan Log
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '12px', flexWrap: 'wrap' }}>
        {([
          { id: 'ready' as ViewTab, label: `Ready to Export (${readyToExport.length})`, color: '#22c55e' },
          { id: 'waiting' as ViewTab, label: `Waiting for PO (${waitingForPO.length})`, color: '#f59e0b' },
          { id: 'exported' as ViewTab, label: `Exported (${exported.length})`, color: '#60a5fa' },
        ]).map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); setSelectedScans(new Set()); }} style={{
            padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
            background: tab === t.id ? 'var(--tab-active-bg)' : 'transparent',
            border: tab === t.id ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
            color: tab === t.id ? t.color : 'var(--text-muted)',
          }}>{t.label}</button>
        ))}
      </div>

      {/* Search */}
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search VIN, part, customer, location, PO..."
        style={{ width: '100%', padding: '10px 14px', borderRadius: '10px', fontSize: '13px', border: `1px solid ${theme.border}`, background: theme.card, color: theme.textPrimary, fontWeight: 600, marginBottom: '10px' }} />

      {/* Actions */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <button onClick={selectAllVisible} style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          {selectedScans.size === tabScans.length && tabScans.length > 0 ? 'Deselect All' : `Select All (${tabScans.length})`}
        </button>
        {tab === 'waiting' && waitingForPO.length > 0 && (
          <button onClick={runAutoMatch} disabled={matching} style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.25)', color: '#a78bfa', cursor: 'pointer' }}>
            {matching ? 'Matching...' : 'Try Auto-Match POs'}
          </button>
        )}
        {tab === 'ready' && selectedScans.size > 0 && (
          <button onClick={exportCSV} disabled={exporting} style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)', color: '#22c55e', cursor: 'pointer' }}>
            {exporting ? 'Exporting...' : `Export ${selectedScans.size} to CSV`}
          </button>
        )}
        {tab === 'exported' && selectedScans.size > 0 && (
          <button onClick={archiveExported} style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.25)', color: '#a78bfa', cursor: 'pointer' }}>
            Archive {selectedScans.size}
          </button>
        )}
      </div>

      {/* Empty state */}
      {tabScans.length === 0 && (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)', fontSize: '13px', fontWeight: 600 }}>
          {tab === 'ready' ? 'No scans ready to export' : tab === 'waiting' ? 'No scans waiting for PO — all matched!' : 'No exported scans'}
        </div>
      )}

      {/* Grouped list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {customerKeys.map(customer => {
          const subGroups = grouped[customer];
          const subKeys = Object.keys(subGroups).sort();
          const totalVins = subKeys.reduce((sum, k) => sum + subGroups[k].length, 0);
          const isCustomerCollapsed = collapsedGroups.has(customer);

          return (
            <div key={customer}>
              {/* Customer header */}
              <div onClick={() => toggleGroup(customer)} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '10px 14px', borderRadius: '10px', cursor: 'pointer',
                background: 'var(--card)', border: '1px solid var(--border)', marginBottom: isCustomerCollapsed ? 0 : '6px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', transition: 'transform 0.15s', transform: isCustomerCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▼</span>
                  <span style={{ fontWeight: 800, fontSize: '14px', color: 'var(--text-primary)' }}>{customer}</span>
                </div>
                <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)' }}>{totalVins} VIN{totalVins !== 1 ? 's' : ''}</span>
              </div>

              {!isCustomerCollapsed && (
                <div style={{ paddingLeft: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {subKeys.map(subKey => {
                    const groupScans = subGroups[subKey];
                    const subCollapsed = collapsedGroups.has(`${customer}|${subKey}`);
                    const [partLabel, locLabel] = subKey.split(' · ');

                    return (
                      <div key={subKey}>
                        {/* Part + location sub-header */}
                        <div onClick={() => toggleGroup(`${customer}|${subKey}`)} style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          padding: '6px 10px', borderRadius: '8px', cursor: 'pointer',
                          background: 'var(--subtle-bg)', border: '1px solid var(--border)', marginBottom: subCollapsed ? 0 : '3px',
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ fontSize: '9px', color: 'var(--text-muted)', transform: subCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▼</span>
                            <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>{partLabel}</span>
                            <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{locLabel}</span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            {groupScans[0]?.po_number && <span style={{ fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: 'rgba(34,197,94,0.1)', color: '#22c55e' }}>PO #{groupScans[0].po_number}</span>}
                            <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)' }}>{groupScans.length}</span>
                          </div>
                        </div>

                        {/* VIN list */}
                        {!subCollapsed && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', paddingLeft: '10px' }}>
                            {groupScans.map(scan => (
                              <div key={scan.id} style={{
                                display: 'flex', alignItems: 'center', gap: '8px',
                                padding: '6px 10px', borderRadius: '6px',
                                background: 'var(--card)', border: `1px solid ${scan.po_id ? 'rgba(34,197,94,0.15)' : 'var(--border)'}`,
                              }}>
                                {tab !== 'archived' && (
                                  <input type="checkbox" checked={selectedScans.has(scan.id)} onChange={() => toggleSelect(scan.id)} style={{ width: '14px', height: '14px', flexShrink: 0 }} />
                                )}
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)' }}>
                                    {[scan.vehicle_year, scan.vehicle_make, scan.vehicle_model].filter(Boolean).join(' ') || 'Unknown'}
                                  </div>
                                  <div style={{ fontSize: '9px', fontFamily: 'monospace', color: 'var(--text-muted)' }}>{scan.vin}</div>
                                </div>
                                <div style={{ fontSize: '9px', color: 'var(--text-muted)', textAlign: 'right', flexShrink: 0 }}>
                                  {profiles[scan.scanned_by || ''] || ''}<br />
                                  {new Date(scan.scanned_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
