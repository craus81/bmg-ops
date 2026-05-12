'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

export default function ReportsPage() {
  const router = useRouter();
  const supabase = createClient();
  const { user, isAdmin } = useAuth();
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);
  const [exportedCount, setExportedCount] = useState(0);
  const [tab, setTab] = useState<'review' | 'pending' | 'archive'>('review');
  const [archives, setArchives] = useState<any[]>([]);
  const [loadingArchive, setLoadingArchive] = useState(false);
  const [archiveSearch, setArchiveSearch] = useState('');
  const [expandedBatch, setExpandedBatch] = useState<string | null>(null);
  const [editingArchiveVehicle, setEditingArchiveVehicle] = useState<string | null>(null);
  const [archiveEditValues, setArchiveEditValues] = useState<Record<string, string>>({});
  const [savingArchiveEdit, setSavingArchiveEdit] = useState(false);

  // Review Matches state
  const [reviewVehicles, setReviewVehicles] = useState<any[]>([]);
  const [loadingReview, setLoadingReview] = useState(false);
  const [availablePoLines, setAvailablePoLines] = useState<any[]>([]);
  const [editingVehicleId, setEditingVehicleId] = useState<string | null>(null);
  const [savingMatch, setSavingMatch] = useState<string | null>(null);
  const [matchMessage, setMatchMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Direct invoice state
  const [selectedForInvoice, setSelectedForInvoice] = useState<Set<string>>(new Set());
  const [creatingInvoice, setCreatingInvoice] = useState(false);
  const [invoiceResults, setInvoiceResults] = useState<any>(null);

  useEffect(() => {
    if (user) {
      loadReview();
      loadPending();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [user]);

  var loadReview = async () => {
    setLoadingReview(true);
    // Load all pending vehicles with their PO matches
    let query = supabase
      .from('scanned_vehicles')
      .select('*, po_line_items(id, po_id, part_number, quantity, installed, purchase_orders(id, po_number, customer, status))')
      .is('exported_at', null)
      .order('scanned_at', { ascending: false });

    if (!isAdmin) {
      query = query.eq('scanned_by', user!.id);
    }

    var { data } = await query;
    setReviewVehicles(data || []);

    // Also load all open PO lines for the dropdown
    var { data: poLines } = await supabase
      .from('po_line_items')
      .select('id, po_id, part_number, description, quantity, installed, purchase_orders!inner(id, po_number, customer, status)')
      .eq('purchase_orders.status', 'open');

    setAvailablePoLines(poLines || []);
    setLoadingReview(false);
  };

  var loadPending = async () => {
    setLoading(true);
    let query = supabase
      .from('scanned_vehicles')
      .select('*, po_line_items(po_id, purchase_orders(po_number))')
      .is('exported_at', null)
      .order('scanned_at', { ascending: false });

    if (!isAdmin) {
      query = query.eq('scanned_by', user!.id);
    }

    var { data } = await query;
    setVehicles(data || []);
    setLoading(false);
  };

  var loadArchive = async () => {
    setLoadingArchive(true);
    let query = supabase
      .from('scanned_vehicles')
      .select('*, po_line_items(po_id, purchase_orders(po_number))')
      .not('exported_at', 'is', null)
      .order('exported_at', { ascending: false })
      .limit(5000);

    if (!isAdmin) {
      query = query.eq('scanned_by', user!.id);
    }

    var { data } = await query;
    setArchives(data || []);
    setLoadingArchive(false);
  };

  var switchTab = (t: 'review' | 'pending' | 'archive') => {
    setTab(t);
    if (t === 'archive') loadArchive();
    if (t === 'review') loadReview();
    if (t === 'pending') loadPending();
  };

  // ─── Match Review Functions ──────────────────────────────
  var handleChangeMatch = async (vehicleId: string, newPoLineItemId: string) => {
    var vehicle = reviewVehicles.find((v: any) => v.id === vehicleId);
    if (!vehicle) return;

    var oldPoLineItemId = vehicle.po_line_item_id;
    if (oldPoLineItemId === newPoLineItemId) return;

    setSavingMatch(vehicleId);
    setMatchMessage(null);

    try {
      var res = await fetch('/api/vehicles/update-match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vehicleId,
          newPoLineItemId: newPoLineItemId || null,
          oldPoLineItemId: oldPoLineItemId || null,
        }),
      });

      if (!res.ok) {
        var err = await res.json();
        setMatchMessage({ type: 'error', text: err.error || 'Failed to update match' });
        return;
      }

      setMatchMessage({ type: 'success', text: 'Match updated' });
      setTimeout(() => setMatchMessage(null), 2000);

      // Reload data to reflect changes
      await loadReview();
      await loadPending();
      setEditingVehicleId(null);
    } catch (e: any) {
      setMatchMessage({ type: 'error', text: e.message || 'Failed to update' });
    } finally {
      setSavingMatch(null);
    }
  };

  // Get available PO lines filtered for a vehicle's part number
  var getMatchOptions = (vehicle: any) => {
    // Show all open PO lines that match this vehicle's part number
    // Also show lines from any PO if user wants to override
    var partNumber = vehicle.part_number?.toUpperCase();
    var matchingLines = availablePoLines.filter((line: any) => {
      var linePartUpper = line.part_number?.toUpperCase();
      return linePartUpper === partNumber;
    });

    // Also include all other open lines grouped separately
    var otherLines = availablePoLines.filter((line: any) => {
      var linePartUpper = line.part_number?.toUpperCase();
      return linePartUpper !== partNumber;
    });

    return { matchingLines, otherLines };
  };

  var getPoLabel = (line: any) => {
    var po = line.purchase_orders;
    var remaining = line.quantity - line.installed;
    return `PO #${po?.po_number || '?'} — ${line.part_number} (${remaining} remaining of ${line.quantity})`;
  };

  var getCurrentMatchLabel = (vehicle: any) => {
    if (!vehicle.po_line_items) return 'No match';
    var po = vehicle.po_line_items.purchase_orders;
    return `PO #${po?.po_number || '?'} — ${vehicle.po_line_items.part_number}`;
  };

  // ─── Direct Invoice Functions ──────────────────────────────

  var toggleInvoiceSelect = (vehicleId: string) => {
    setSelectedForInvoice(prev => {
      var next = new Set(prev);
      if (next.has(vehicleId)) next.delete(vehicleId);
      else next.add(vehicleId);
      return next;
    });
  };

  var selectAllForInvoice = (customer: string) => {
    var custVehicles = reviewGrouped[customer] || [];
    // Only select vehicles that don't have a PO match and haven't been invoiced
    var eligibleIds = custVehicles
      .filter((v: any) => !v.po_line_item_id && !v.netsuite_invoice_id)
      .map((v: any) => v.id);

    setSelectedForInvoice(prev => {
      var next = new Set(prev);
      var allSelected = eligibleIds.every((id: string) => next.has(id));
      if (allSelected) {
        eligibleIds.forEach((id: string) => next.delete(id));
      } else {
        eligibleIds.forEach((id: string) => next.add(id));
      }
      return next;
    });
  };

  var handleCreateDirectInvoice = async () => {
    if (selectedForInvoice.size === 0) return;
    setCreatingInvoice(true);
    setInvoiceResults(null);

    try {
      var res = await fetch('/api/netsuite/invoice-vehicles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vehicleIds: Array.from(selectedForInvoice) }),
      });

      var data = await res.json();
      setInvoiceResults(data);

      if (data.results?.some((r: any) => r.status === 'success')) {
        setSelectedForInvoice(new Set());
        await loadReview();
      }
    } catch (e: any) {
      setInvoiceResults({ error: e.message || 'Failed to create invoices' });
    }
    setCreatingInvoice(false);
  };

  // ─── Export Functions ──────────────────────────────

  // Group vehicles by customer
  var grouped: Record<string, any[]> = {};
  vehicles.forEach(function(v) {
    var key = v.customer || 'No Customer';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(v);
  });

  function getPONumber(v: any): string {
    return v.po_line_items?.purchase_orders?.po_number || '';
  }

  var handleExportAll = async () => {
    if (vehicles.length === 0) return;
    setExporting(true);
    try {
      var XLSX = await import('xlsx');
      var now = new Date();

      var baseUrl = window.location.origin;
      var rows = vehicles.map(function(v: any) {
        var scanDate = new Date(v.scanned_at);
        return {
          'PO Number': getPONumber(v),
          'VIN': v.vin,
          'Part Number': v.part_number || '',
          'Customer': v.customer || '',
          'End Customer': v.end_customer || '',
          'Location': v.install_location || '',
          'Year': v.vehicle_year || '',
          'Make': v.vehicle_make || '',
          'Model': v.vehicle_model || '',
          'Date Scanned': scanDate.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }),
          'Photos': baseUrl + '/view/' + v.id,
        };
      });

      var ws = XLSX.utils.json_to_sheet(rows);
      ws['!cols'] = [{ wch: 14 }, { wch: 20 }, { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 16 }, { wch: 6 }, { wch: 14 }, { wch: 16 }, { wch: 12 }, { wch: 40 }];
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Vehicles');

      var dateStr = now.toISOString().slice(0, 10);
      var filename = 'BMG-Export-' + dateStr + '.xlsx';
      XLSX.writeFile(wb, filename);

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

      var baseUrl = window.location.origin;
      var rows = custVehicles.map(function(v: any) {
        var scanDate = new Date(v.scanned_at);
        return {
          'PO Number': getPONumber(v),
          'VIN': v.vin,
          'Part Number': v.part_number || '',
          'Customer': v.customer || '',
          'End Customer': v.end_customer || '',
          'Location': v.install_location || '',
          'Year': v.vehicle_year || '',
          'Make': v.vehicle_make || '',
          'Model': v.vehicle_model || '',
          'Date Scanned': scanDate.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }),
          'Photos': baseUrl + '/view/' + v.id,
        };
      });

      var ws = XLSX.utils.json_to_sheet(rows);
      ws['!cols'] = [{ wch: 14 }, { wch: 20 }, { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 16 }, { wch: 6 }, { wch: 14 }, { wch: 16 }, { wch: 12 }, { wch: 40 }];
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Vehicles');

      var safeCustomer = customer.replace(/[^a-zA-Z0-9]/g, '_');
      var dateStr = now.toISOString().slice(0, 10);
      var filename = 'BMG-' + safeCustomer + '-' + dateStr + '.xlsx';
      XLSX.writeFile(wb, filename);

      var ids = custVehicles.map(function(v: any) { return v.id; });
      await supabase
        .from('scanned_vehicles')
        .update({ exported_at: now.toISOString() })
        .in('id', ids);

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

      var baseUrl = window.location.origin;
      var rows = batch.map(function(v: any) {
        var scanDate = new Date(v.scanned_at);
        return {
          'PO Number': getPONumber(v),
          'VIN': v.vin,
          'Part Number': v.part_number || '',
          'Customer': v.customer || '',
          'End Customer': v.end_customer || '',
          'Location': v.install_location || '',
          'Year': v.vehicle_year || '',
          'Make': v.vehicle_make || '',
          'Model': v.vehicle_model || '',
          'Date Scanned': scanDate.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }),
          'Photos': baseUrl + '/view/' + v.id,
        };
      });

      var ws = XLSX.utils.json_to_sheet(rows);
      ws['!cols'] = [{ wch: 14 }, { wch: 20 }, { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 16 }, { wch: 6 }, { wch: 14 }, { wch: 16 }, { wch: 12 }, { wch: 40 }];
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Vehicles');

      var dateStr = new Date(exportDate).toISOString().slice(0, 10);
      XLSX.writeFile(wb, 'BMG-Export-' + dateStr + '.xlsx');
    } catch (e: any) {
      console.error('Re-download error:', e);
    }
  };

  // Start editing an archived vehicle
  var startArchiveEdit = function(v: any) {
    setEditingArchiveVehicle(v.id);
    setArchiveEditValues({
      vin: v.vin || '',
      part_number: v.part_number || '',
      customer: v.customer || '',
      end_customer: v.end_customer || '',
      install_location: v.install_location || '',
      vehicle_year: v.vehicle_year || '',
      vehicle_make: v.vehicle_make || '',
      vehicle_model: v.vehicle_model || '',
    });
  };

  // Save archive vehicle edits to DB and update local state
  var saveArchiveEdit = async function(vehicleId: string) {
    setSavingArchiveEdit(true);
    try {
      var updates: any = {};
      var fields = ['vin', 'part_number', 'customer', 'end_customer', 'install_location', 'vehicle_year', 'vehicle_make', 'vehicle_model'];
      fields.forEach(function(f) {
        updates[f] = archiveEditValues[f] || null;
      });
      await supabase.from('scanned_vehicles').update(updates).eq('id', vehicleId);
      // Update local state
      setArchives(function(prev) {
        return prev.map(function(v) {
          if (v.id === vehicleId) return { ...v, ...updates };
          return v;
        });
      });
      setEditingArchiveVehicle(null);
    } catch (e: any) {
      console.error('Save error:', e);
    }
    setSavingArchiveEdit(false);
  };

  // Group archives by export timestamp, with search filtering
  var archiveGroups: Record<string, any[]> = {};
  var searchLower = archiveSearch.toLowerCase().trim();
  archives.forEach(function(v) {
    var key = v.exported_at?.slice(0, 19) || 'unknown';
    if (!archiveGroups[key]) archiveGroups[key] = [];
    archiveGroups[key].push(v);
  });
  // Filter groups by search term — match batch metadata or individual VINs
  if (searchLower) {
    var filtered: Record<string, any[]> = {};
    Object.keys(archiveGroups).forEach(function(key) {
      var batch = archiveGroups[key];
      var batchDate = new Date(key);
      var dateStr = batchDate.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }).toLowerCase();
      var customers = batch.map(function(v: any) { return (v.customer || '').toLowerCase(); }).join(' ');
      var locations = batch.map(function(v: any) { return (v.install_location || '').toLowerCase(); }).join(' ');
      // Check if batch-level metadata matches
      var batchMatch = dateStr.includes(searchLower) || customers.includes(searchLower) || locations.includes(searchLower);
      if (batchMatch) {
        filtered[key] = batch;
      } else {
        // Check individual VINs within the batch
        var matchingVins = batch.filter(function(v: any) {
          return (v.vin || '').toLowerCase().includes(searchLower) ||
            (v.part_number || '').toLowerCase().includes(searchLower) ||
            (v.vehicle_make || '').toLowerCase().includes(searchLower) ||
            (v.vehicle_model || '').toLowerCase().includes(searchLower) ||
            (v.install_location || '').toLowerCase().includes(searchLower) ||
            (v.customer || '').toLowerCase().includes(searchLower) ||
            (v.end_customer || '').toLowerCase().includes(searchLower) ||
            (getPONumber(v) || '').toLowerCase().includes(searchLower);
        });
        if (matchingVins.length > 0) {
          filtered[key] = batch; // Show full batch but auto-expand it
        }
      }
    });
    archiveGroups = filtered;
  }

  // Group review vehicles by customer for organization
  var reviewGrouped: Record<string, any[]> = {};
  reviewVehicles.forEach(function(v) {
    var key = v.customer || 'No Customer';
    if (!reviewGrouped[key]) reviewGrouped[key] = [];
    reviewGrouped[key].push(v);
  });

  // Count unmatched vehicles
  var unmatchedCount = reviewVehicles.filter((v: any) => !v.po_line_item_id).length;

  if (loading && loadingReview) {
    return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
        {isAdmin ? 'Reports' : 'My Reports'}
      </div>

      <div style={{ display: 'flex', gap: '4px', marginBottom: '12px', background: 'var(--card)', borderRadius: '10px', padding: '3px' }}>
        <button onClick={function() { switchTab('review'); }} style={{ flex: 1, padding: '8px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, background: tab === 'review' ? 'var(--tab-active-bg)' : 'transparent', border: 'none', color: tab === 'review' ? 'var(--navy)' : 'var(--text-muted)' }}>
          Review {unmatchedCount > 0 ? '(' + unmatchedCount + ')' : ''}
        </button>
        <button onClick={function() { switchTab('pending'); }} style={{ flex: 1, padding: '8px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, background: tab === 'pending' ? 'var(--tab-active-bg)' : 'transparent', border: 'none', color: tab === 'pending' ? 'var(--navy)' : 'var(--text-muted)' }}>
          Export {vehicles.length > 0 ? '(' + vehicles.length + ')' : ''}
        </button>
        <button onClick={function() { switchTab('archive'); }} style={{ flex: 1, padding: '8px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, background: tab === 'archive' ? 'var(--tab-active-bg)' : 'transparent', border: 'none', color: tab === 'archive' ? 'var(--navy)' : 'var(--text-muted)' }}>Archive</button>
      </div>

      {matchMessage && (
        <div style={{
          padding: '10px 12px',
          background: matchMessage.type === 'success' ? 'var(--success-bg)' : 'rgba(239,68,68,0.08)',
          border: matchMessage.type === 'success' ? '1px solid rgba(52,211,153,0.15)' : '1px solid rgba(239,68,68,0.15)',
          borderRadius: '10px',
          color: matchMessage.type === 'success' ? 'var(--success)' : '#ef4444',
          fontSize: '13px', fontWeight: 700, marginBottom: '12px', textAlign: 'center'
        }}>
          {matchMessage.text}
        </div>
      )}

      {exported && (
        <div style={{ padding: '10px 12px', background: 'var(--success-bg)', border: '1px solid rgba(52,211,153,0.15)', borderRadius: '10px', color: 'var(--success)', fontSize: '13px', fontWeight: 700, marginBottom: '12px', textAlign: 'center' }}>
          Exported {exportedCount} vehicles
        </div>
      )}

      {/* ─── Review Matches Tab ──────────────────────────────── */}
      {tab === 'review' && (
        <div>
          {loadingReview ? (
            <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)' }}>Loading matches...</div>
          ) : reviewVehicles.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)' }}>
              <div style={{ fontSize: '36px', marginBottom: '6px', opacity: 0.4 }}>&#10003;</div>
              <div style={{ fontWeight: 600, fontSize: '13px' }}>No vehicles pending review</div>
            </div>
          ) : (
            <div>
              {/* Summary banner */}
              <div style={{ padding: '10px 12px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '10px', marginBottom: '12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: '14px' }}>{reviewVehicles.length} vehicles pending</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                      {reviewVehicles.length - unmatchedCount} matched &middot; {unmatchedCount > 0 ? <span style={{ color: '#fbbf24' }}>{unmatchedCount} unmatched</span> : <span style={{ color: 'var(--success)' }}>all matched</span>}
                    </div>
                  </div>
                  <button
                    onClick={loadReview}
                    style={{ padding: '6px 12px', borderRadius: '8px', background: 'rgba(238,49,32,0.06)', border: '1px solid rgba(238,49,32,0.15)', color: 'var(--navy)', fontSize: '11px', fontWeight: 700 }}
                  >
                    Refresh
                  </button>
                </div>

                {/* Direct invoice controls */}
                {selectedForInvoice.size > 0 && (
                  <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid rgba(30,45,61,0.5)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: '12px', fontWeight: 700, color: '#a78bfa' }}>
                      {selectedForInvoice.size} selected for invoice
                    </div>
                    <button
                      onClick={handleCreateDirectInvoice}
                      disabled={creatingInvoice}
                      style={{ padding: '6px 14px', borderRadius: '8px', background: '#a78bfa', border: 'none', color: '#fff', fontSize: '11px', fontWeight: 700 }}
                    >
                      {creatingInvoice ? 'Creating...' : 'Create Invoice'}
                    </button>
                  </div>
                )}

                {/* Invoice results */}
                {invoiceResults && (
                  <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid rgba(30,45,61,0.5)' }}>
                    {invoiceResults.error ? (
                      <div style={{ fontSize: '11px', color: '#ef4444' }}>{invoiceResults.error}</div>
                    ) : invoiceResults.results ? (
                      <div style={{ fontSize: '11px' }}>
                        {invoiceResults.results.map((r: any, i: number) => (
                          <div key={i} style={{ marginTop: i > 0 ? '4px' : 0, color: r.status === 'success' ? '#34d399' : '#ef4444' }}>
                            {r.customer}: {r.status === 'success' ? `Invoice #${r.invoiceNumber} (${r.vehicleCount} vehicles)` : r.error}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>

              {/* Vehicles grouped by customer */}
              {Object.keys(reviewGrouped).map(function(customer) {
                var custVehicles = reviewGrouped[customer];
                var custUnmatched = custVehicles.filter((v: any) => !v.po_line_item_id).length;
                return (
                  <div key={customer} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '12px', marginBottom: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                      <div>
                        <div style={{ fontWeight: 800, fontSize: '14px' }}>{customer}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '1px' }}>
                          {custVehicles.length} vehicle{custVehicles.length !== 1 ? 's' : ''}
                          {custUnmatched > 0 && <span style={{ color: '#fbbf24', marginLeft: '6px' }}>{custUnmatched} unmatched</span>}
                        </div>
                      </div>
                      {/* Select unmatched vehicles for direct invoicing */}
                      {(() => {
                        var invoiceableInGroup = custVehicles.filter((v: any) => !v.po_line_item_id && !v.netsuite_invoice_id);
                        if (invoiceableInGroup.length === 0) return null;
                        var allSelected = invoiceableInGroup.every((v: any) => selectedForInvoice.has(v.id));
                        return (
                          <button
                            onClick={() => selectAllForInvoice(customer)}
                            style={{ padding: '4px 10px', borderRadius: '6px', background: allSelected ? 'rgba(167,139,250,0.15)' : 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.25)', color: '#a78bfa', fontSize: '10px', fontWeight: 700 }}
                          >
                            {allSelected ? 'Deselect' : 'Select'} for Invoice ({invoiceableInGroup.length})
                          </button>
                        );
                      })()}
                    </div>

                    {custVehicles.map(function(v: any) {
                      var title = [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || 'Unknown';
                      var isEditing = editingVehicleId === v.id;
                      var isSaving = savingMatch === v.id;
                      var hasMatch = !!v.po_line_item_id;
                      var isInvoiced = !!v.netsuite_invoice_id;
                      var canInvoiceDirect = !hasMatch && !isInvoiced;
                      var { matchingLines, otherLines } = getMatchOptions(v);

                      return (
                        <div key={v.id} style={{ padding: '8px 0', borderTop: '1px solid rgba(30,45,61,0.5)' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', flex: 1, minWidth: 0 }}>
                              {/* Invoice checkbox for unmatched, uninvoiced vehicles */}
                              {canInvoiceDirect && (
                                <input
                                  type="checkbox"
                                  checked={selectedForInvoice.has(v.id)}
                                  onChange={() => toggleInvoiceSelect(v.id)}
                                  style={{ marginTop: '2px', width: '14px', height: '14px', accentColor: '#a78bfa', cursor: 'pointer', flexShrink: 0 }}
                                />
                              )}
                              <div>
                                <div style={{ fontWeight: 600, fontSize: '12px', color: 'var(--text-primary)' }}>{title}</div>
                                <div style={{ fontFamily: 'monospace', fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>{v.vin}</div>
                                {v.part_number && <div style={{ fontSize: '10px', color: 'var(--navy-light)', marginTop: '2px' }}>{v.part_number}</div>}
                              </div>
                            </div>
                            <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: '8px' }}>
                              {!isEditing ? (
                                <div>
                                  <div style={{
                                    fontSize: '10px',
                                    fontWeight: 700,
                                    color: isInvoiced ? '#a78bfa' : hasMatch ? 'var(--success)' : '#fbbf24',
                                    padding: '2px 8px',
                                    borderRadius: '6px',
                                    background: isInvoiced ? 'rgba(167,139,250,0.08)' : hasMatch ? 'var(--success-bg)' : 'rgba(251,191,36,0.08)',
                                    border: isInvoiced ? '1px solid rgba(167,139,250,0.15)' : hasMatch ? '1px solid rgba(52,211,153,0.15)' : '1px solid rgba(251,191,36,0.15)',
                                    display: 'inline-block',
                                    marginBottom: '4px',
                                  }}>
                                    {isInvoiced ? 'Invoiced' : hasMatch ? getCurrentMatchLabel(v) : 'Unmatched'}
                                  </div>
                                  <div>
                                    <button
                                      onClick={() => setEditingVehicleId(v.id)}
                                      style={{ padding: '4px 10px', borderRadius: '6px', background: 'transparent', border: '1px solid rgba(238,49,32,0.2)', color: 'var(--navy)', fontSize: '10px', fontWeight: 700 }}
                                    >
                                      {hasMatch ? 'Change' : 'Assign'}
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <div style={{ minWidth: '200px' }}>
                                  <select
                                    disabled={isSaving}
                                    defaultValue={v.po_line_item_id || ''}
                                    onChange={(e) => handleChangeMatch(v.id, e.target.value)}
                                    style={{
                                      width: '100%',
                                      padding: '6px 8px',
                                      borderRadius: '8px',
                                      border: '1px solid rgba(238,49,32,0.3)',
                                      background: 'var(--bg)',
                                      color: 'var(--text-primary)',
                                      fontSize: '10px',
                                      fontWeight: 600,
                                    }}
                                  >
                                    <option value="">-- No Match --</option>
                                    {matchingLines.length > 0 && (
                                      <optgroup label="Matching Part Number">
                                        {matchingLines.map((line: any) => (
                                          <option key={line.id} value={line.id}>{getPoLabel(line)}</option>
                                        ))}
                                      </optgroup>
                                    )}
                                    {otherLines.length > 0 && (
                                      <optgroup label="Other Open PO Lines">
                                        {otherLines.map((line: any) => (
                                          <option key={line.id} value={line.id}>{getPoLabel(line)}</option>
                                        ))}
                                      </optgroup>
                                    )}
                                  </select>
                                  <div style={{ marginTop: '4px' }}>
                                    <button
                                      onClick={() => setEditingVehicleId(null)}
                                      style={{ padding: '3px 8px', borderRadius: '6px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: '10px', fontWeight: 600 }}
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                  {isSaving && <div style={{ fontSize: '10px', color: 'var(--navy)', marginTop: '4px' }}>Saving...</div>}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ─── Export (Pending) Tab ──────────────────────────────── */}
      {tab === 'pending' && (
        <div>
          {vehicles.length === 0 && !exported && (
            <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)' }}>
              <div style={{ fontSize: '36px', marginBottom: '6px', opacity: 0.4 }}>&#10003;</div>
              <div style={{ fontWeight: 600, fontSize: '13px' }}>All caught up - nothing to export</div>
            </div>
          )}

          {vehicles.length > 0 && (
            <div>
              <button
                onClick={handleExportAll}
                disabled={exporting}
                style={{ width: '100%', padding: '14px', borderRadius: '14px', background: 'var(--success)', color: '#fff', fontSize: '15px', fontWeight: 800, border: 'none', marginBottom: '12px' }}
              >
                {exporting ? 'Exporting...' : 'Export All (' + vehicles.length + ' vehicles)'}
              </button>

              {Object.keys(grouped).map(function(customer) {
                var custVehicles = grouped[customer];
                return (
                  <div key={customer} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '12px', marginBottom: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                      <div>
                        <div style={{ fontWeight: 800, fontSize: '14px' }}>{customer}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '1px' }}>{custVehicles.length} vehicle{custVehicles.length !== 1 ? 's' : ''}</div>
                      </div>
                      <button
                        onClick={function() { handleExportCustomer(customer); }}
                        disabled={exporting}
                        style={{ padding: '8px 14px', borderRadius: '10px', background: 'var(--navy)', color: '#fff', fontSize: '12px', fontWeight: 700, border: 'none' }}
                      >
                        Export
                      </button>
                    </div>
                    {custVehicles.slice(0, 5).map(function(v: any) {
                      var title = [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || 'Unknown';
                      return (
                        <div key={v.id} style={{ padding: '4px 0', fontSize: '11px', borderTop: '1px solid rgba(30,45,61,0.5)' }}>
                          <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{title}</span>
                          <span style={{ color: 'var(--text-muted)', marginLeft: '6px', fontFamily: 'monospace', fontSize: '10px' }}>{v.vin}</span>
                          {v.part_number && <span style={{ color: 'var(--navy-light)', marginLeft: '6px', fontSize: '10px' }}>{v.part_number}</span>}
                        </div>
                      );
                    })}
                    {custVehicles.length > 5 && (
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>+ {custVehicles.length - 5} more</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ─── Archive Tab ──────────────────────────────── */}
      {tab === 'archive' && (
        <div>
          {/* Search bar */}
          <div style={{ marginBottom: '12px' }}>
            <input
              value={archiveSearch}
              onChange={function(e) { setArchiveSearch(e.target.value); }}
              placeholder="Search by VIN, customer, location, part#, PO..."
              style={{ width: '100%', padding: '10px 12px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '13px' }}
            />
            {searchLower && (
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                {Object.keys(archiveGroups).length} batch{Object.keys(archiveGroups).length !== 1 ? 'es' : ''} · {Object.values(archiveGroups).reduce(function(sum, b) { return sum + b.length; }, 0)} vehicles matched
              </div>
            )}
          </div>

          {loadingArchive ? (
            <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)' }}>Loading archive...</div>
          ) : Object.keys(archiveGroups).length === 0 ? (
            <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)' }}>
              <div style={{ fontSize: '36px', marginBottom: '6px', opacity: 0.4 }}>&#128193;</div>
              <div style={{ fontWeight: 600, fontSize: '13px' }}>{searchLower ? 'No results found' : 'No exports yet'}</div>
            </div>
          ) : (
            Object.keys(archiveGroups).map(function(exportDate) {
              var batch = archiveGroups[exportDate];
              var date = new Date(exportDate);
              var customers = Array.from(new Set(batch.map(function(v: any) { return v.customer || 'Unknown'; })));
              var locations = Array.from(new Set(batch.filter(function(v: any) { return v.install_location; }).map(function(v: any) { return v.install_location; })));
              var isExpanded = expandedBatch === exportDate;
              return (
                <div key={exportDate} style={{ background: 'var(--card)', border: '1px solid var(--border-strong)', borderRadius: '14px', marginBottom: '8px', overflow: 'hidden' }}>
                  <div
                    onClick={function() { setExpandedBatch(isExpanded ? null : exportDate); }}
                    style={{ padding: '12px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--text-primary)' }}>
                        {date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })} at {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                        {batch.length} vehicle{batch.length !== 1 ? 's' : ''} &mdash; {customers.join(', ')}
                      </div>
                      {locations.length > 0 && (
                        <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
                          {locations.join(', ')}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      <button
                        onClick={function(e) { e.stopPropagation(); handleRedownload(exportDate); }}
                        style={{ padding: '6px 12px', borderRadius: '8px', background: 'var(--orange-soft)', border: '1px solid rgba(238,49,32,0.15)', color: 'var(--text-label)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}
                      >
                        Download
                      </button>
                      <span style={{ fontSize: '16px', color: 'var(--text-muted)', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>▾</span>
                    </div>
                  </div>
                  {isExpanded && (
                    <div style={{ borderTop: '1px solid var(--border)', padding: '8px', maxHeight: '400px', overflowY: 'auto' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '3px' }}>
                        {batch.map(function(v: any) {
                          var vinMatch = searchLower && (v.vin || '').toLowerCase().includes(searchLower);
                          var isEditing = editingArchiveVehicle === v.id;
                          if (isEditing) {
                            var editFieldStyle: React.CSSProperties = { fontSize: '11px', padding: '4px 6px', borderRadius: '5px', border: '1px solid var(--border-strong)', background: 'var(--input-bg)', color: 'var(--text-primary)', width: '100%' };
                            var editLabelStyle: React.CSSProperties = { fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' as const, letterSpacing: '0.3px', marginBottom: '2px' };
                            return (
                              <div key={v.id} style={{ padding: '10px', borderRadius: '8px', background: 'var(--card)', border: '1px solid var(--border-strong)' }}>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '8px' }}>
                                  <div>
                                    <div style={editLabelStyle}>VIN</div>
                                    <input style={editFieldStyle} value={archiveEditValues.vin || ''} onChange={function(e) { setArchiveEditValues(function(p) { return { ...p, vin: e.target.value }; }); }} />
                                  </div>
                                  <div>
                                    <div style={editLabelStyle}>Part #</div>
                                    <input style={editFieldStyle} value={archiveEditValues.part_number || ''} onChange={function(e) { setArchiveEditValues(function(p) { return { ...p, part_number: e.target.value }; }); }} />
                                  </div>
                                  <div>
                                    <div style={editLabelStyle}>Customer</div>
                                    <input style={editFieldStyle} value={archiveEditValues.customer || ''} onChange={function(e) { setArchiveEditValues(function(p) { return { ...p, customer: e.target.value }; }); }} />
                                  </div>
                                  <div>
                                    <div style={editLabelStyle}>End Customer</div>
                                    <input style={editFieldStyle} value={archiveEditValues.end_customer || ''} onChange={function(e) { setArchiveEditValues(function(p) { return { ...p, end_customer: e.target.value }; }); }} />
                                  </div>
                                  <div>
                                    <div style={editLabelStyle}>Location</div>
                                    <input style={editFieldStyle} value={archiveEditValues.install_location || ''} onChange={function(e) { setArchiveEditValues(function(p) { return { ...p, install_location: e.target.value }; }); }} />
                                  </div>
                                  <div>
                                    <div style={editLabelStyle}>Year / Make / Model</div>
                                    <div style={{ display: 'flex', gap: '4px' }}>
                                      <input style={{ ...editFieldStyle, width: '50px' }} value={archiveEditValues.vehicle_year || ''} onChange={function(e) { setArchiveEditValues(function(p) { return { ...p, vehicle_year: e.target.value }; }); }} placeholder="Year" />
                                      <input style={{ ...editFieldStyle, flex: 1 }} value={archiveEditValues.vehicle_make || ''} onChange={function(e) { setArchiveEditValues(function(p) { return { ...p, vehicle_make: e.target.value }; }); }} placeholder="Make" />
                                      <input style={{ ...editFieldStyle, flex: 1 }} value={archiveEditValues.vehicle_model || ''} onChange={function(e) { setArchiveEditValues(function(p) { return { ...p, vehicle_model: e.target.value }; }); }} placeholder="Model" />
                                    </div>
                                  </div>
                                </div>
                                <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                                  <button onClick={function() { setEditingArchiveVehicle(null); }} style={{ padding: '5px 12px', borderRadius: '6px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>Cancel</button>
                                  <button onClick={function() { saveArchiveEdit(v.id); }} disabled={savingArchiveEdit} style={{ padding: '5px 12px', borderRadius: '6px', border: 'none', background: 'var(--success)', color: '#fff', fontSize: '11px', fontWeight: 700, cursor: 'pointer', opacity: savingArchiveEdit ? 0.6 : 1 }}>{savingArchiveEdit ? 'Saving...' : 'Save'}</button>
                                </div>
                              </div>
                            );
                          }
                          return (
                            <div key={v.id} onClick={function() { startArchiveEdit(v); }} style={{ padding: '6px 8px', borderRadius: '6px', fontSize: '11px', background: vinMatch ? 'var(--warning-bg)' : 'var(--subtle-bg)', border: vinMatch ? '1px solid var(--warning-border)' : '1px solid transparent', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }} title="Click to edit">
                              <div>
                                <span style={{ fontFamily: 'monospace', fontWeight: 700, color: 'var(--text-primary)', fontSize: '12px' }}>{v.vin}</span>
                                <span style={{ color: 'var(--text-muted)', marginLeft: '8px' }}>
                                  {v.vehicle_year} {v.vehicle_make} {v.vehicle_model}
                                </span>
                              </div>
                              <div style={{ display: 'flex', gap: '6px', alignItems: 'center', fontSize: '10px', color: 'var(--text-muted)' }}>
                                {v.part_number && <span style={{ padding: '1px 5px', borderRadius: '4px', background: 'var(--subtle-bg)', border: '1px solid var(--border)' }}>{v.part_number}</span>}
                                {v.install_location && <span>{v.install_location}</span>}
                                {getPONumber(v) && <span style={{ color: 'var(--warning)' }}>PO #{getPONumber(v)}</span>}
                                <span style={{ fontSize: '10px', opacity: 0.4, color: 'var(--text-muted)' }}>Edit</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {/* Re-export button */}
                      <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid var(--border)' }}>
                        <button
                          onClick={function(e) { e.stopPropagation(); handleRedownload(exportDate); }}
                          style={{ width: '100%', padding: '10px', borderRadius: '8px', border: 'none', background: 'var(--navy)', color: '#fff', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
                        >
                          Re-export Updated List
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      <button onClick={function() { router.push('/more'); }} style={{ width: '100%', padding: '10px', borderRadius: '14px', marginTop: '12px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 700 }}>Back</button>
    </div>
  );
}
