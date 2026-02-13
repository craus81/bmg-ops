'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import type { ScannedVehicle, PurchaseOrder } from '@/lib/types';

export default function ReportsPage() {
  const router = useRouter();
  const supabase = createClient();
  const [pos, setPos] = useState<PurchaseOrder[]>([]);
  const [vehicles, setVehicles] = useState<ScannedVehicle[]>([]);
  const [selectedPo, setSelectedPo] = useState<string>('');
  const [filtered, setFiltered] = useState<ScannedVehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);

  useEffect(() => {
    var load = async () => {
      var poResult = await supabase
        .from('purchase_orders')
        .select('*')
        .order('created_at', { ascending: false });

      var vehResult = await supabase
        .from('scanned_vehicles')
        .select('*')
        .order('scanned_at', { ascending: false });

      setPos(poResult.data || []);
      setVehicles(vehResult.data || []);
      setLoading(false);
    };
    load();
  }, []);

  useEffect(() => {
    if (!selectedPo) {
      setFiltered(vehicles);
      return;
    }
    var po = pos.find(function(p) { return p.id === selectedPo; });
    if (!po) {
      setFiltered([]);
      return;
    }
    var match = vehicles.filter(function(v) {
      return v.customer === po.customer;
    });
    setFiltered(match);
  }, [selectedPo, vehicles, pos]);

  var handleExport = async () => {
    if (filtered.length === 0) return;
    setExporting(true);

    try {
      var XLSX = await import('xlsx');

      var po = pos.find(function(p) { return p.id === selectedPo; });
      var poNumber = po ? po.po_number : 'All';
      var customerName = po ? po.customer : 'All Customers';

      var rows = filtered.map(function(v) {
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

      var colWidths = [
        { wch: 20 },
        { wch: 16 },
        { wch: 14 },
        { wch: 6 },
        { wch: 14 },
        { wch: 16 },
        { wch: 12 },
      ];
      ws['!cols'] = colWidths;

      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Vehicles');

      var filename = 'BMG-' + customerName.replace(/[^a-zA-Z0-9]/g, '_') + '-' + poNumber.replace(/[^a-zA-Z0-9]/g, '_') + '.xlsx';
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
          style={{
            width: '100%', padding: '10px 12px', borderRadius: '8px',
            border: '1px solid #1e2d3d', background: '#141e2b', color: '#e8ecf1',
            fontSize: '14px', fontWeight: 600,
          }}
        >
          <option value="">All Vehicles</option>
          {pos.map(function(po) {
            return (
              <option key={po.id} value={po.id}>
                {po.po_number} - {po.customer}
              </option>
            );
          })}
        </select>
      </div>

      <div style={{
        background: '#141e2b', border: '1px solid #1e2d3d', borderRadius: '10px',
        padding: '14px', marginBottom: '12px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700 }}>{filtered.length} vehicle{filtered.length !== 1 ? 's' : ''}</div>
            <div style={{ fontSize: '11px', color: '#4a5f78', marginTop: '2px' }}>
              {selectedPo ? pos.find(function(p) { return p.id === selectedPo; })?.customer || '' : 'All customers'}
            </div>
          </div>
          <button
            onClick={handleExport}
            disabled={filtered.length === 0 || exporting}
            style={{
              padding: '10px 20px', borderRadius: '8px',
              background: filtered.length > 0 ? '#22c55e' : '#1e2d3d',
              color: '#fff', fontSize: '13px', fontWeight: 800, border: 'none',
              opacity: filtered.length > 0 ? 1 : 0.4,
            }}
          >
            {exporting ? 'Exporting...' : exported ? 'Downloaded!' : 'Download .xlsx'}
          </button>
        </div>

        {filtered.length > 0 && (
          <div style={{ fontSize: '10px', color: '#4a5f78', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px', borderBottom: '1px solid #1e2d3d', paddingBottom: '6px' }}>
            Preview
          </div>
        )}

        <div style={{ maxHeight: '300px', overflow: 'auto' }}>
          {filtered.slice(0, 20).map(function(v) {
            var title = [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || 'Unknown';
            var scanDate = new Date(v.scanned_at);
            return (
              <div key={v.id} style={{ padding: '8px 0', borderBottom: '1px solid rgba(30,45,61,0.5)', fontSize: '12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <div style={{ fontWeight: 700, color: '#e8ecf1' }}>{title}</div>
                  <div style={{ color: '#4a5f78', fontSize: '10px' }}>{scanDate.toLocaleDateString([], { month: 'short', day: 'numeric' })}</div>
                </div>
                <div style={{ fontFamily: 'monospace', color: '#4a5f78', fontSize: '10px', marginTop: '2px' }}>{v.vin}</div>
                {v.part_number && (
                  <div style={{ color: '#93c5fd', fontSize: '10px', marginTop: '1px' }}>{v.part_number}</div>
                )}
              </div>
            );
          })}
          {filtered.length > 20 && (
            <div style={{ textAlign: 'center', padding: '8px', color: '#4a5f78', fontSize: '11px' }}>
              + {filtered.length - 20} more vehicles
            </div>
          )}
        </div>
      </div>

      <button onClick={function() { router.push('/home'); }} style={{ width: '100%', padding: '10px', borderRadius: '10px', marginTop: '8px', border: '1px solid #1e2d3d', background: 'transparent', color: '#6b7a8d', fontSize: '13px', fontWeight: 700 }}>Back</button>
    </div>
  );
}
