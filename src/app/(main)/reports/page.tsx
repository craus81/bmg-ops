'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';

export default function ReportsPage() {
  const router = useRouter();
  const supabase = createClient();
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);
  const [exportedCount, setExportedCount] = useState(0);
  const [tab, setTab] = useState<'pending' | 'archive'>('pending');
  const [archives, setArchives] = useState<any[]>([]);
  const [loadingArchive, setLoadingArchive] = useState(false);

  useEffect(() => {
    loadPending();
  }, []);

  var loadPending = async () => {
    setLoading(true);
    var { data } = await supabase
      .from('scanned_vehicles')
      .select('*')
      .is('exported_at', null)
      .order('scanned_at', { ascending: false });
    setVehicles(data || []);
    setLoading(false);
  };

  var loadArchive = async () => {
    setLoadingArchive(true);
    var { data } = await supabase
      .from('scanned_vehicles')
      .select('*')
      .not('exported_at', 'is', null)
      .order('exported_at', { ascending: false });
    setArchives(data || []);
    setLoadingArchive(false);
  };

  var switchTab = (t: 'pending' | 'archive') => {
    setTab(t);
    if (t === 'archive') loadArchive();
  };

  // Group vehicles by customer
  var grouped: Record<string, any[]> = {};
  vehicles.forEach(function(v) {
    var key = v.customer || 'No Customer';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(v);
  });

  var handleExportAll = async () => {
    if (vehicles.length === 0) return;
    setExporting(true);
    try {
      var XLSX = await import('xlsx');
      var now = new Date();

      var rows = vehicles.map(function(v: any) {
        var scanDate = new Date(v.scanned_at);
        return {
          'VIN': v.vin,
          'Part Number': v.part_number || '',
          'Customer': v.customer || '',
          'End Customer': v.end_customer || '',
          'Year': v.vehicle_year || '',
          'Make': v.vehicle_make || '',
          'Model': v.vehicle_model || '',
          'Date Scanned': scanDate.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }),
        };
      });

      var ws = XLSX.utils.json_to_sheet(rows);
      ws['!cols'] = [{ wch: 20 }, { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 6 }, { wch: 14 }, { wch: 16 }, { wch: 12 }];
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Vehicles');

      var dateStr = now.toISOString().slice(0, 10);
      var filename = 'BMG-Export-' + dateStr + '.xlsx';
      XLSX.writeFile(wb, filename);

      // Mark all as exported
      var ids = vehicles.map(function(v: any) { return v.id; });
      await supabase
        .from('scanned_vehicles')
        .update({ exported_at: now.toISOString() })
        .in('id', ids);

      setExportedCount(vehicles.length);
      setExported(true);
      setVehicles([]);
    } catch (e: any) {
      console.error('Export error:', e);
    }
    setExporting(false);
  };

  var handleExportCustomer = async (customer: string) => {
    var custVehicles = grouped[customer];
    if (!custVehicles || custVehicles.length === 0) return;
    setExporting(true);
    try {
      var XLSX = await import('xlsx');
      var now = new Date();

      var rows = custVehicles.map(function(v: any) {
        var scanDate = new Date(v.scanned_at);
        return {
          'VIN': v.vin,
          'Part Number': v.part_number || '',
          'Customer': v.customer || '',
          'End Customer': v.end_customer || '',
          'Year': v.vehicle_year || '',
          'Make': v.vehicle_make || '',
          'Model': v.vehicle_model || '',
          'Date Scanned': scanDate.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }),
        };
      });

      var ws = XLSX.utils.json_to_sheet(rows);
      ws['!cols'] = [{ wch: 20 }, { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 6 }, { wch: 14 }, { wch: 16 }, { wch: 12 }];
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Vehicles');

      var safeCustomer = customer.replace(/[^a-zA-Z0-9]/g, '_');
      var dateStr = now.toISOString().slice(0, 10);
      var filename = 'BMG-' + safeCustomer + '-' + dateStr + '.xlsx';
      XLSX.writeFile(wb, filename);

      // Mark these as exported
      var ids = custVehicles.map(function(v: any) { return v.id; });
      await supabase
        .from('scanned_vehicles')
        .update({ exported_at: now.toISOString() })
        .in('id', ids);

      // Remove from pending list
      setVehicles(function(prev: any[]) {
        return prev.filter(function(v: any) { return !ids.includes(v.id); });
      });

      setExportedCount(custVehicles.length);
      setExported(true);
      setTimeout(function() { setExported(false); }, 3000);
    } catch (e: any) {
      console.error('Export error:', e);
    }
    setExporting(false);
  };

  var handleRedownload = async (exportDate: string) => {
    try {
      var XLSX = await import('xlsx');
      var batch = archives.filter(function(v: any) {
        return v.exported_at && v.exported_at.slice(0, 19) === exportDate.slice(0, 19);
      });
      if (batch.length === 0) return;

      var rows = batch.map(function(v: any) {
        var scanDate = new Date(v.scanned_at);
        return {
          'VIN': v.vin,
          'Part Number': v.part_number || '',
          'Customer': v.customer || '',
          'End Customer': v.end_customer || '',
          'Year': v.vehicle_year || '',
          'Make': v.vehicle_make || '',
          'Model': v.vehicle_model || '',
          'Date Scanned': scanDate.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }),
        };
      });

      var ws = XLSX.utils.json_to_sheet(rows);
      ws['!cols'] = [{ wch: 20 }, { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 6 }, { wch: 14 }, { wch: 16 }, { wch: 12 }];
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Vehicles');

      var dateStr = new Date(exportDate).toISOString().slice(0, 10);
      XLSX.writeFile(wb, 'BMG-Export-' + dateStr + '.xlsx');
    } catch (e: any) {
      console.error('Re-download error:', e);
    }
  };

  // Group archives by export timestamp
  var archiveGroups: Record<string, any[]> = {};
  archives.forEach(function(v) {
    var key = v.exported_at?.slice(0, 19) || 'unknown';
    if (!archiveGroups[key]) archiveGroups[key] = [];
    archiveGroups[key].push(v);
  });

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '40px', color: '#4a5f78' }}>Loading...</div>;
  }

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>Reports</div>

      <div style={{ display: 'flex', gap: '4px', marginBottom: '12px', background: '#141e2b', borderRadius: '8px', padding: '3px' }}>
        <button onClick={function() { switchTab('pending'); }} style={{ flex: 1, padding: '8px', borderRadius: '6px', fontSize: '12px', fontWeight: 700, background: tab === 'pending' ? 'rgba(59,130,246,0.15)' : 'transparent', border: 'none', color: tab === 'pending' ? '#60a5fa' : '#4a5f78' }}>
          Ready to Export {vehicles.length > 0 ? '(' + vehicles.length + ')' : ''}
        </button>
        <button onClick={function() { switchTab('archive'); }} style={{ flex: 1, padding: '8px', borderRadius: '6px', fontSize: '12px', fontWeight: 700, background: tab === 'archive' ? 'rgba(59,130,246,0.15)' : 'transparent', border: 'none', color: tab === 'archive' ? '#60a5fa' : '#4a5f78' }}>Archive</button>
      </div>

      {exported && (
        <div style={{ padding: '10px 12px', background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.2)', borderRadius: '8px', color: '#4ade80', fontSize: '13px', fontWeight: 700, marginBottom: '12px', textAlign: 'center' }}>
          Exported {exportedCount} vehicles
        </div>
      )}

      {tab === 'pending' && (
        <div>
          {vehicles.length === 0 && !exported && (
            <div style={{ textAlign: 'center', padding: '32px 0', color: '#4a5f78' }}>
              <div style={{ fontSize: '36px', marginBottom: '6px', opacity: 0.4 }}>✓</div>
              <div style={{ fontWeight: 600, fontSize: '13px' }}>All caught up - nothing to export</div>
            </div>
          )}

          {vehicles.length > 0 && (
            <div>
              <button
                onClick={handleExportAll}
                disabled={exporting}
                style={{ width: '100%', padding: '14px', borderRadius: '10px', background: '#22c55e', color: '#fff', fontSize: '15px', fontWeight: 800, border: 'none', marginBottom: '12px' }}
              >
                {exporting ? 'Exporting...' : 'Export All (' + vehicles.length + ' vehicles)'}
              </button>

              {Object.keys(grouped).map(function(customer) {
                var custVehicles = grouped[customer];
                return (
                  <div key={customer} style={{ background: '#141e2b', border: '1px solid #1e2d3d', borderRadius: '10px', padding: '12px', marginBottom: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                      <div>
                        <div style={{ fontWeight: 800, fontSize: '14px' }}>{customer}</div>
                        <div style={{ fontSize: '11px', color: '#4a5f78', marginTop: '1px' }}>{custVehicles.length} vehicle{custVehicles.length !== 1 ? 's' : ''}</div>
                      </div>
                      <button
                        onClick={function() { handleExportCustomer(customer); }}
                        disabled={exporting}
                        style={{ padding: '8px 14px', borderRadius: '8px', background: '#3b82f6', color: '#fff', fontSize: '12px', fontWeight: 700, border: 'none' }}
                      >
                        Export
                      </button>
                    </div>
                    {custVehicles.slice(0, 5).map(function(v: any) {
                      var title = [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || 'Unknown';
                      return (
                        <div key={v.id} style={{ padding: '4px 0', fontSize: '11px', borderTop: '1px solid rgba(30,45,61,0.5)' }}>
                          <span style={{ fontWeight: 600, color: '#e8ecf1' }}>{title}</span>
                          <span style={{ color: '#4a5f78', marginLeft: '6px', fontFamily: 'monospace', fontSize: '10px' }}>{v.vin}</span>
                          {v.part_number && <span style={{ color: '#93c5fd', marginLeft: '6px', fontSize: '10px' }}>{v.part_number}</span>}
                        </div>
                      );
                    })}
                    {custVehicles.length > 5 && (
                      <div style={{ fontSize: '10px', color: '#4a5f78', marginTop: '4px' }}>+ {custVehicles.length - 5} more</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === 'archive' && (
        <div>
          {loadingArchive ? (
            <div style={{ textAlign: 'center', padding: '20px', color: '#4a5f78' }}>Loading archive...</div>
          ) : Object.keys(archiveGroups).length === 0 ? (
            <div style={{ textAlign: 'center', padding: '32px 0', color: '#4a5f78' }}>
              <div style={{ fontSize: '36px', marginBottom: '6px', opacity: 0.4 }}>📁</div>
              <div style={{ fontWeight: 600, fontSize: '13px' }}>No exports yet</div>
            </div>
          ) : (
            Object.keys(archiveGroups).map(function(exportDate) {
              var batch = archiveGroups[exportDate];
              var date = new Date(exportDate);
              var customers = Array.from(new Set(batch.map(function(v: any) { return v.customer || 'Unknown'; })));
              return (
                <div key={exportDate} style={{ background: '#141e2b', border: '1px solid #1e2d3d', borderRadius: '10px', padding: '12px', marginBottom: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '13px' }}>
                        {date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })} at {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                      <div style={{ fontSize: '11px', color: '#4a5f78', marginTop: '2px' }}>
                        {batch.length} vehicles — {customers.join(', ')}
                      </div>
                    </div>
                    <button
                      onClick={function() { handleRedownload(exportDate); }}
                      style={{ padding: '8px 14px', borderRadius: '8px', background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.25)', color: '#60a5fa', fontSize: '12px', fontWeight: 700 }}
                    >
                      Re-download
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      <button onClick={function() { router.push('/more'); }} style={{ width: '100%', padding: '10px', borderRadius: '10px', marginTop: '12px', border: '1px solid #1e2d3d', background: 'transparent', color: '#6b7a8d', fontSize: '13px', fontWeight: 700 }}>Back</button>
    </div>
  );
}
