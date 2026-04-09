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
  location_id: string | null;
  location_name: string | null;
  po_id: string | null;
  po_number: string | null;
  scanned_by: string | null;
  scanned_at: string;
  exported_at: string | null;
  archived_at: string | null;
  scanner_name?: string;
}

interface PO {
  id: string;
  po_number: string;
  customer: string;
  ship_to: { name?: string; city?: string; state?: string } | null;
  line_items: { id: string; part_number: string; quantity: number; installed: number }[];
}

type ViewTab = 'pending' | 'exported' | 'archived';

export default function AdminScansPage() {
  const { isAdmin, user } = useAuth();
  const supabase = createClient();

  const [scans, setScans] = useState<ScanLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<ViewTab>('pending');
  const [search, setSearch] = useState('');
  const [profiles, setProfiles] = useState<Record<string, string>>({});
  const [selectedScans, setSelectedScans] = useState<Set<string>>(new Set());
  const [openPOs, setOpenPOs] = useState<PO[]>([]);
  const [matchingPO, setMatchingPO] = useState<string | null>(null); // scan id being matched
  const [exporting, setExporting] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadScans();
    loadProfiles();
    loadOpenPOs();
  }, [tab]);

  const loadScans = async () => {
    setLoading(true);
    let query = supabase
      .from('scan_logs')
      .select('*')
      .order('scanned_at', { ascending: false })
      .limit(500);

    if (tab === 'pending') query = query.is('exported_at', null).is('archived_at', null);
    else if (tab === 'exported') query = query.not('exported_at', 'is', null).is('archived_at', null);
    else if (tab === 'archived') query = query.not('archived_at', 'is', null);

    const { data } = await query;
    setScans((data || []) as ScanLog[]);
    setSelectedScans(new Set());
    setLoading(false);
  };

  const loadProfiles = async () => {
    const { data } = await supabase.from('profiles').select('id, full_name');
    if (data) {
      const map: Record<string, string> = {};
      data.forEach((p: any) => { map[p.id] = p.full_name; });
      setProfiles(map);
    }
  };

  const loadOpenPOs = async () => {
    const { data: pos } = await supabase
      .from('purchase_orders')
      .select('id, po_number, customer, ship_to')
      .eq('status', 'open');
    if (!pos) return;
    const poIds = pos.map(p => p.id);
    const { data: lines } = await supabase
      .from('po_line_items')
      .select('id, po_id, part_number, quantity, installed')
      .in('po_id', poIds.length > 0 ? poIds : ['__none__']);

    const enriched: PO[] = pos.map(po => ({
      ...po,
      ship_to: po.ship_to as PO['ship_to'],
      line_items: (lines || []).filter(l => l.po_id === po.id),
    }));
    setOpenPOs(enriched);
  };

  // Auto-match: find PO by part_number + location
  const findMatchingPO = (scan: ScanLog): PO | null => {
    if (!scan.part_number) return null;
    const scanLoc = (scan.location_name || '').toLowerCase();

    for (const po of openPOs) {
      const hasPartMatch = po.line_items.some(li =>
        li.part_number === scan.part_number && li.installed < li.quantity
      );
      if (!hasPartMatch) continue;

      // Check location match via ship_to
      const shipTo = po.ship_to;
      if (shipTo) {
        const shipName = (shipTo.name || '').toLowerCase();
        const shipCity = (shipTo.city || '').toLowerCase();
        if (scanLoc && (shipName.includes(scanLoc.split(' - ')[1]?.toLowerCase() || scanLoc) || shipCity.includes(scanLoc.split(' - ')[1]?.toLowerCase() || ''))) {
          return po;
        }
      }

      // If no location on scan or PO, match on part alone
      if (!scanLoc || !shipTo) return po;
    }
    return null;
  };

  const matchScanToPO = async (scanId: string, poId: string, poNumber: string) => {
    const scan = scans.find(s => s.id === scanId);
    if (!scan) return;

    // Find matching line item
    const po = openPOs.find(p => p.id === poId);
    const lineItem = po?.line_items.find(li => li.part_number === scan.part_number && li.installed < li.quantity);

    await supabase.from('scan_logs').update({
      po_id: poId,
      po_number: poNumber,
      po_line_item_id: lineItem?.id || null,
    }).eq('id', scanId);

    // Increment installed count
    if (lineItem) {
      await supabase.from('po_line_items').update({ installed: lineItem.installed + 1 }).eq('id', lineItem.id);
    }

    setScans(prev => prev.map(s => s.id === scanId ? { ...s, po_id: poId, po_number: poNumber } : s));
    setMatchingPO(null);
    loadOpenPOs(); // refresh PO data
  };

  const unmatchScan = async (scanId: string) => {
    const scan = scans.find(s => s.id === scanId);
    if (!scan?.po_line_item_id) return;

    // Decrement installed count
    const po = openPOs.find(p => p.id === scan.po_id);
    const li = po?.line_items.find(l => l.id === scan.po_line_item_id);
    if (li && li.installed > 0) {
      await supabase.from('po_line_items').update({ installed: li.installed - 1 }).eq('id', li.id);
    }

    await supabase.from('scan_logs').update({ po_id: null, po_number: null, po_line_item_id: null }).eq('id', scanId);
    setScans(prev => prev.map(s => s.id === scanId ? { ...s, po_id: null, po_number: null } : s));
    loadOpenPOs();
  };

  // Auto-match all unmatched scans
  const autoMatchAll = async () => {
    let matched = 0;
    for (const scan of scans) {
      if (scan.po_id) continue;
      const po = findMatchingPO(scan);
      if (po) {
        await matchScanToPO(scan.id, po.id, po.po_number);
        matched++;
      }
    }
    if (matched > 0) loadScans();
    alert(`Auto-matched ${matched} scan${matched !== 1 ? 's' : ''}`);
  };

  // Export selected scans to CSV
  const exportCSV = async () => {
    const toExport = scans.filter(s => selectedScans.has(s.id));
    if (toExport.length === 0) return;
    setExporting(true);

    const headers = ['VIN', 'Year', 'Make', 'Model', 'Part Number', 'Part Description', 'Billable Customer', 'Location', 'PO Number', 'Scanned By', 'Scanned At'];
    const rows = toExport.map(s => [
      s.vin,
      s.vehicle_year || '',
      s.vehicle_make || '',
      s.vehicle_model || '',
      s.part_number || '',
      s.part_description || '',
      s.billable_customer || '',
      s.location_name || '',
      s.po_number || '',
      profiles[s.scanned_by || ''] || '',
      new Date(s.scanned_at).toLocaleString(),
    ]);

    const csv = [headers, ...rows].map(r => r.map(c => `"${(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scans-export-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    // Mark as exported
    const ids = toExport.map(s => s.id);
    await supabase.from('scan_logs').update({ exported_at: new Date().toISOString(), exported_by: user?.id }).in('id', ids);
    setExporting(false);
    loadScans();
  };

  // Archive exported scans
  const archiveSelected = async () => {
    const ids = [...selectedScans];
    if (ids.length === 0) return;
    await supabase.from('scan_logs').update({ archived_at: new Date().toISOString() }).in('id', ids);
    loadScans();
  };

  const toggleSelectAll = () => {
    if (selectedScans.size === filteredScans.length) setSelectedScans(new Set());
    else setSelectedScans(new Set(filteredScans.map(s => s.id)));
  };

  const toggleSelect = (id: string) => {
    setSelectedScans(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleGroup = (key: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // Filter + group
  const filteredScans = scans.filter(s => {
    if (!search) return true;
    const q = search.toLowerCase();
    return s.vin.toLowerCase().includes(q) ||
      s.part_number?.toLowerCase().includes(q) ||
      s.billable_customer?.toLowerCase().includes(q) ||
      s.location_name?.toLowerCase().includes(q) ||
      s.po_number?.toLowerCase().includes(q) ||
      [s.vehicle_year, s.vehicle_make, s.vehicle_model].filter(Boolean).join(' ').toLowerCase().includes(q);
  });

  const grouped = filteredScans.reduce((acc: Record<string, ScanLog[]>, s) => {
    const key = `${s.part_number || 'No Part'} — ${s.billable_customer || 'No Customer'} — ${s.location_name || 'No Location'}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(s);
    return acc;
  }, {});
  const groupKeys = Object.keys(grouped).sort();

  const pendingCount = scans.filter(s => !s.exported_at && !s.archived_at).length;
  const unmatchedCount = filteredScans.filter(s => !s.po_id && tab === 'pending').length;

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>;

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px' }}>
        Scan Review
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '12px' }}>
        {([
          { id: 'pending' as ViewTab, label: `Pending (${pendingCount})` },
          { id: 'exported' as ViewTab, label: 'Exported' },
          { id: 'archived' as ViewTab, label: 'Archive' },
        ]).map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
            background: tab === t.id ? 'var(--tab-active-bg)' : 'transparent',
            border: tab === t.id ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
            color: tab === t.id ? 'var(--tab-active-color)' : 'var(--text-muted)',
          }}>{t.label}</button>
        ))}
      </div>

      {/* Search */}
      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search VIN, part, customer, location..."
        style={{
          width: '100%', padding: '10px 14px', borderRadius: '10px', fontSize: '13px',
          border: `1px solid ${theme.border}`, background: theme.card,
          color: theme.textPrimary, fontWeight: 600, marginBottom: '10px',
        }}
      />

      {/* Action bar */}
      {tab === 'pending' && (
        <div style={{ display: 'flex', gap: '6px', marginBottom: '12px', flexWrap: 'wrap' }}>
          <button onClick={toggleSelectAll} style={{
            padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
            background: 'var(--subtle-bg)', border: '1px solid var(--border)',
            color: 'var(--text-secondary)', cursor: 'pointer',
          }}>{selectedScans.size === filteredScans.length ? 'Deselect All' : 'Select All'}</button>
          {unmatchedCount > 0 && (
            <button onClick={autoMatchAll} style={{
              padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
              background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.25)',
              color: '#a78bfa', cursor: 'pointer',
            }}>Auto-Match to POs ({unmatchedCount} unmatched)</button>
          )}
          {selectedScans.size > 0 && (
            <button onClick={exportCSV} disabled={exporting} style={{
              padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
              background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)',
              color: '#22c55e', cursor: 'pointer',
            }}>{exporting ? 'Exporting...' : `Export ${selectedScans.size} to CSV`}</button>
          )}
        </div>
      )}

      {tab === 'exported' && selectedScans.size > 0 && (
        <div style={{ marginBottom: '12px' }}>
          <button onClick={toggleSelectAll} style={{
            padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, marginRight: '6px',
            background: 'var(--subtle-bg)', border: '1px solid var(--border)',
            color: 'var(--text-secondary)', cursor: 'pointer',
          }}>{selectedScans.size === filteredScans.length ? 'Deselect All' : 'Select All'}</button>
          <button onClick={archiveSelected} style={{
            padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
            background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.25)',
            color: '#a78bfa', cursor: 'pointer',
          }}>Archive {selectedScans.size} Scans</button>
        </div>
      )}

      {filteredScans.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)', fontSize: '13px', fontWeight: 600 }}>
          {tab === 'pending' ? 'No pending scans' : tab === 'exported' ? 'No exported scans' : 'No archived scans'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {groupKeys.map(groupKey => {
            const groupScans = grouped[groupKey];
            const isCollapsed = collapsedGroups.has(groupKey);
            const matchedCount = groupScans.filter(s => s.po_id).length;
            const [partLabel, customerLabel, locationLabel] = groupKey.split(' — ');

            return (
              <div key={groupKey}>
                {/* Group header */}
                <div
                  onClick={() => toggleGroup(groupKey)}
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '10px 14px', borderRadius: '10px', cursor: 'pointer',
                    background: 'var(--card)', border: '1px solid var(--border)',
                    marginBottom: isCollapsed ? 0 : '4px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)', transition: 'transform 0.15s', transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▼</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 800, fontSize: '12px', color: 'var(--text-primary)' }}>{partLabel}</div>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                        {customerLabel} · {locationLabel}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                    {matchedCount > 0 && <span style={{ fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: 'rgba(34,197,94,0.1)', color: '#22c55e' }}>{matchedCount} matched</span>}
                    {matchedCount < groupScans.length && tab === 'pending' && <span style={{ fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: 'rgba(251,191,36,0.1)', color: '#f59e0b' }}>{groupScans.length - matchedCount} unmatched</span>}
                    <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)' }}>{groupScans.length}</span>
                  </div>
                </div>

                {/* Scans */}
                {!isCollapsed && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', paddingLeft: '12px' }}>
                    {groupScans.map(scan => (
                      <div key={scan.id} style={{
                        display: 'flex', alignItems: 'center', gap: '8px',
                        padding: '8px 12px', borderRadius: '8px',
                        background: 'var(--card)', border: `1px solid ${scan.po_id ? 'rgba(34,197,94,0.2)' : 'var(--border)'}`,
                      }}>
                        {tab !== 'archived' && (
                          <input
                            type="checkbox"
                            checked={selectedScans.has(scan.id)}
                            onChange={() => toggleSelect(scan.id)}
                            style={{ width: '14px', height: '14px', flexShrink: 0 }}
                          />
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
                            {[scan.vehicle_year, scan.vehicle_make, scan.vehicle_model].filter(Boolean).join(' ') || 'Unknown'}
                          </div>
                          <div style={{ fontSize: '10px', fontFamily: 'monospace', color: 'var(--text-muted)' }}>{scan.vin}</div>
                          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '1px' }}>
                            {profiles[scan.scanned_by || ''] || 'Unknown'} · {new Date(scan.scanned_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                          </div>
                        </div>
                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                          {scan.po_number ? (
                            <div>
                              <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: 'rgba(34,197,94,0.1)', color: '#22c55e' }}>PO #{scan.po_number}</span>
                              {tab === 'pending' && (
                                <button onClick={() => unmatchScan(scan.id)} style={{ marginLeft: '4px', fontSize: '9px', color: '#f87171', background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
                              )}
                            </div>
                          ) : tab === 'pending' ? (
                            <button onClick={() => setMatchingPO(matchingPO === scan.id ? null : scan.id)} style={{
                              fontSize: '9px', fontWeight: 700, padding: '3px 8px', borderRadius: '4px',
                              background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.25)',
                              color: '#f59e0b', cursor: 'pointer',
                            }}>Match PO</button>
                          ) : null}
                        </div>
                      </div>
                    ))}

                    {/* Manual PO matching dropdown */}
                    {matchingPO && groupScans.some(s => s.id === matchingPO) && (
                      <div style={{ padding: '8px 12px', borderRadius: '8px', background: 'var(--subtle-bg)', border: '1px solid var(--border)' }}>
                        <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>Select PO to match:</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '150px', overflowY: 'auto' }}>
                          {openPOs.filter(po => {
                            const scan = scans.find(s => s.id === matchingPO);
                            return po.line_items.some(li => li.part_number === scan?.part_number);
                          }).map(po => (
                            <button key={po.id} onClick={() => matchScanToPO(matchingPO, po.id, po.po_number)} style={{
                              padding: '6px 10px', borderRadius: '6px', textAlign: 'left', fontSize: '11px',
                              background: 'var(--card)', border: '1px solid var(--border)', cursor: 'pointer',
                            }}>
                              <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>PO #{po.po_number}</span>
                              <span style={{ color: 'var(--text-muted)', marginLeft: '6px' }}>{po.customer}</span>
                              {po.ship_to?.city && <span style={{ color: 'var(--text-muted)', marginLeft: '4px' }}>· {po.ship_to.city}</span>}
                            </button>
                          ))}
                          {openPOs.filter(po => {
                            const scan = scans.find(s => s.id === matchingPO);
                            return po.line_items.some(li => li.part_number === scan?.part_number);
                          }).length === 0 && (
                            <div style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '8px' }}>No open POs with matching part number</div>
                          )}
                        </div>
                        <button onClick={() => setMatchingPO(null)} style={{
                          marginTop: '6px', fontSize: '10px', fontWeight: 700, padding: '4px 10px', borderRadius: '6px',
                          background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer',
                        }}>Cancel</button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
