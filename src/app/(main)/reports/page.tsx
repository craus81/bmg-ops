'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import type { PurchaseOrder } from '@/lib/types';

export default function ReportsPage() {
  const router = useRouter();
  const supabase = createClient();
  const [pos, setPos] = useState<any[]>([]);
  const [selectedPo, setSelectedPo] = useState<string>('');
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingVehicles, setLoadingVehicles] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);

  useEffect(() => {
    var load = async () => {
      var { data } = await supabase
        .from('purchase_orders')
        .select('*, po_line_items(id, part_number, quantity, installed)')
        .order('created_at', { ascending: false });

      var mapped = (data || []).map(function(po: any) {
        return { ...po, line_items: po.po_line_items || [] };
      });
      setPos(mapped);
      setLoading(false);
    };
    load();
  }, []);

  useEffect(() => {
    if (!selectedPo) { setVehicles([]); return; }
    var loadVehicles = async () => {
      setLoadingVehicles(true);
      var po = pos.find(function(p: any) { return p.id === selectedPo; });
      if (!po) { setLoadingVehicles(false); return; }

      var lineIds = po.line_items.map(function(l: any) { return l.id; });
      if (lineIds.length === 0) { setVehicles([]); setLoadingVehicles(false); return; }

      var { data } = await supabase
        .from('scanned_vehicles')
        .select('*')
        .in('po_line_item_id', lineIds)
        .order('scanned_at', { ascending: false });

      setVehicles(data || []);
      setLoadingVehicles(false);
    };
    loadVehicles();
  }, [selectedPo, pos]);

  var handleExport = async () => {
    if (vehicles.length === 0) return;
    setExporting(true);
    try {
      var XLSX = await import('xlsx');
      var po = pos.find(function(p: any) { return p.id === selectedPo; });
      var poNumber = po ? po.po_number : 'Unknown';
      var customerName = po ? po.customer : 'Unknown';

      var rows = vehicles.map(function(v: any) {
        var scanDate = new Date(v.scanned_at);
        return {
          'VIN': v.vin,
          'Part Number': v.part_number || '',
          'PO Number': poNumber,
          'Year': v.vehicle_year || '',
          'Make': v.vehicle_make || '',
          'Model': v.vehicle_model || '',
          'Date Scanned': scanDate.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }),
        };
      });

      var ws = XLSX.utils.json_to_sheet(rows);
      ws['!cols'] = [{ wch: 20 }, { wch: 16 }, { wch: 14 }, { wch: 6 }, { wch: 14 }, { wch: 16 }, { wch: 12 }];
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Vehicles');
      var filename = 'BMG-' + customerName.replace(/[^a-zA-Z0-9]/g, '_') + '-PO' + poNumber.replace(/[^a-zA-Z0-9]/g, '_') + '.xlsx';
      XLSX.writeFile(wb, filename);
      setExported(true);
      setTimeout(function() { setExported(false); }, 3000);
    } catch (e: any) {
      console.error('Export error:', e);
    }
    setExporting(false);
  };

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '40px', color: '#4a5f78' }}>Loading...</div>;
  }

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>Export Report</div>

      <div style={{ marginBottom: '12px' }}>
        <div style={{ fontSize: '12px', color: '#6b7a8d', marginBottom: '6px', fontWeight: 600 }}>Select Purchase Order</div>
        <select
          value={selectedPo}
          onChange={function(e) { setSelectedPo(e.target.value); }}
          style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #1e2d3d', background: '#141e2b', color: '#e8ecf1', fontSize: '14px', fontWeight: 600 }}
        >
          <option value="">-- Select a PO --</option>
          {pos.map(function(po: any) {
            var totalQty = po.line_items.reduce(function(s: number, l: any) { return s + l.quantity; }, 0);
            var totalInstalled = po.line_items.reduce(function(s: number, l: any) { return s + l.installed; }, 0);
            return (
              <option key={po.id} value={po.id}>
                PO #{po.po_number} - {po.customer} ({totalInstalled}/{totalQty}) {po.status === 'complete' ? ' COMPLETE' : ''}
              </option>
            );
          })}
        </select>
      </div>

      {selectedPo && (
        <div style={{ background: '#141e2b', border: '1px solid #1e2d3d', borderRadius: '10px', padding: '14px', marginBottom: '12px' }}>
          {loadingVehicles ? (
            <div style={{ textAlign: 'center', padding: '20px', color: '#4a5f78' }}>Loading vehicles...</div>
          ) : (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 700 }}>{vehicles.length} vehicle{vehicles.length !== 1 ? 's' : ''} linked</div>
                  <div style={{ fontSize: '11px', color: '#4a5f78', marginTop: '2px' }}>
                    {pos.find(function(p: any) { return p.id === selectedPo; })?.customer || ''}
                  </div>
                </div>
                <button
                  onClick={handleExport}
                  disabled={vehicles.length === 0 || exporting}
                  style={{
                    padding: '10px 20px', borderRadius: '8px',
                    background: vehicles.length > 0 ? '#22c55e' : '#1e2d3d',
                    color: '#fff', fontSize: '13px', fontWeight: 800, border: 'none',
                    opacity: vehicles.length > 0 ? 1 : 0.4,
                  }}
                >
                  {exporting ? 'Exporting...' : exported ? 'Downloaded!' : 'Download .xlsx'}
                </button>
              </div>

              {vehicles.length === 0 && (
                <div style={{ textAlign: 'center', padding: '16px', color: '#4a5f78', fontSize: '13px' }}>No vehicles scanned for this PO yet</div>
              )}

              {vehicles.length > 0 && (
                <div>
                  <div style={{ fontSize: '10px', color: '#4a5f78', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px', borderBottom: '1px solid #1e2d3d', paddingBottom: '6px' }}>Preview</div>
                  <div style={{ maxHeight: '300px', overflow: 'auto' }}>
                    {vehicles.slice(0, 20).map(function(v: any) {
                      var title = [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || 'Unknown';
                      var scanDate = new Date(v.scanned_at);
                      return (
                        <div key={v.id} style={{ padding: '8px 0', borderBottom: '1px solid rgba(30,45,61,0.5)', fontSize: '12px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <div style={{ fontWeight: 700, color: '#e8ecf1' }}>{title}</div>
                            <div style={{ color: '#4a5f78', fontSize: '10px' }}>{scanDate.toLocaleDateString([], { month: 'short', day: 'numeric' })}</div>
                          </div>
                          <div style={{ fontFamily: 'monospace', color: '#4a5f78', fontSize: '10px', marginTop: '2px' }}>{v.vin}</div>
                          {v.part_number && <div style={{ color: '#93c5fd', fontSize: '10px', marginTop: '1px' }}>{v.part_number}</div>}
                        </div>
                      );
                    })}
                    {vehicles.length > 20 && (
                      <div style={{ textAlign: 'center', padding: '8px', color: '#4a5f78', fontSize: '11px' }}>+ {vehicles.length - 20} more</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <button onClick={function() { router.push('/more'); }} style={{ width: '100%', padding: '10px', borderRadius: '10px', marginTop: '8px', border: '1px solid #1e2d3d', background: 'transparent', color: '#6b7a8d', fontSize: '13px', fontWeight: 700 }}>Back</button>
    </div>
  );
}
