'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

interface PO {
  id: string;
  po_number: string;
  customer: string;
  status: string;
  ordered_date: string | null;
  po_line_items: { id: string; part_number: string; description: string | null; quantity: number; installed: number; unit_price: number }[];
}

interface AssignPOModalProps {
  open: boolean;
  onClose: () => void;
  vehicleId: string;
  vehiclePartNumber: string | null;
  vehicleVin: string;
  onAssigned: (result: { po_number: string; customer: string; matched_line_item_id: string; matched_part_number: string }) => void;
}

export default function AssignPOModal({ open, onClose, vehicleId, vehiclePartNumber, vehicleVin, onAssigned }: AssignPOModalProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [pos, setPOs] = useState<PO[]>([]);
  const [searching, setSearching] = useState(false);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100);
      setQuery('');
      setPOs([]);
      setError(null);
      // Load recent POs immediately
      fetchPOs('');
    }
  }, [open]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (open) document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  const fetchPOs = useCallback(async (q: string) => {
    setSearching(true);
    try {
      const res = await fetch(`/api/vehicles/assign-po?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      setPOs(data.pos || []);
    } catch {
      setPOs([]);
    } finally {
      setSearching(false);
    }
  }, []);

  const handleInput = (val: string) => {
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchPOs(val), 300);
  };

  const handleAssign = async (po: PO) => {
    setAssigning(po.id);
    setError(null);
    try {
      const res = await fetch('/api/vehicles/assign-po', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vehicleId,
          poId: po.id,
          partNumber: vehiclePartNumber,
        }),
      });
      const data = await res.json();
      if (data.success) {
        onAssigned({
          po_number: data.po_number,
          customer: data.customer,
          matched_line_item_id: data.matched_line_item_id,
          matched_part_number: data.matched_part_number,
        });
        onClose();
      } else {
        setError(data.error || 'Failed to assign PO');
      }
    } catch {
      setError('Network error — try again');
    } finally {
      setAssigning(null);
    }
  };

  if (!open) return null;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 300,
      background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)',
      display: 'flex', flexDirection: 'column',
    }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: '500px', margin: '0 auto',
          maxHeight: '100vh', display: 'flex', flexDirection: 'column',
          background: '#0f1720',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '14px 16px', borderBottom: '1px solid #1e2d3d',
          position: 'sticky', top: 0, background: '#0f1720', zIndex: 1,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <div>
              <div style={{ fontSize: '15px', fontWeight: 800, color: '#f5f8fc' }}>Assign Purchase Order</div>
              <div style={{ fontSize: '11px', color: '#dce6f0', marginTop: '2px' }}>
                VIN: {vehicleVin}{vehiclePartNumber ? ` · Part: ${vehiclePartNumber}` : ''}
              </div>
            </div>
            <button onClick={onClose} style={{
              background: 'transparent', border: '1px solid #1e2d3d', borderRadius: '6px',
              padding: '4px 10px', color: '#dce6f0', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
            }}>ESC</button>
          </div>

          {/* Search input */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '16px', opacity: 0.5 }}>📋</span>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => handleInput(e.target.value)}
              placeholder="Search by PO number or customer..."
              style={{
                flex: 1, background: 'rgba(255,255,255,0.04)', border: '1px solid #1e2d3d',
                borderRadius: '10px', padding: '10px 12px', outline: 'none',
                color: '#f5f8fc', fontSize: '14px', fontWeight: 600,
              }}
            />
          </div>
        </div>

        {/* Error */}
        {error && (
          <div style={{
            margin: '8px 16px 0', padding: '8px 12px', borderRadius: '8px',
            background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)',
            color: '#f87171', fontSize: '12px', fontWeight: 600,
          }}>
            {error}
          </div>
        )}

        {/* Results */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {searching && (
            <div style={{ padding: '32px', textAlign: 'center', color: '#e8f0f8', fontSize: '13px' }}>
              Loading POs...
            </div>
          )}

          {!searching && pos.length === 0 && (
            <div style={{ padding: '40px 20px', textAlign: 'center' }}>
              <div style={{ fontSize: '32px', opacity: 0.3, marginBottom: '8px' }}>📋</div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: '#e8f0f8' }}>No POs found</div>
              <div style={{ fontSize: '12px', color: '#3a4a5d', marginTop: '4px' }}>Try a different search term</div>
            </div>
          )}

          {pos.map((po) => {
            const lineCount = po.po_line_items?.length || 0;
            const totalValue = (po.po_line_items || []).reduce((s, l) => s + (l.quantity * l.unit_price), 0);
            const matchingLine = vehiclePartNumber
              ? po.po_line_items?.find((l) => l.part_number?.toLowerCase() === vehiclePartNumber.toLowerCase())
              : null;
            const hasCapacity = po.po_line_items?.some((l) => l.installed < l.quantity);
            const isAssigning = assigning === po.id;

            return (
              <div key={po.id} style={{
                borderBottom: '1px solid rgba(30,45,61,0.5)',
                padding: '12px 16px',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '6px' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '13px', fontWeight: 700, color: '#f5f8fc' }}>PO #{po.po_number}</span>
                      <span style={{
                        fontSize: '10px', fontWeight: 700,
                        color: po.status === 'open' ? '#fbbf24' : '#4ade80',
                        textTransform: 'capitalize',
                      }}>{po.status}</span>
                      {matchingLine && (
                        <span style={{
                          padding: '1px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: 700,
                          background: 'rgba(74,222,128,0.1)', border: '1px solid rgba(74,222,128,0.2)',
                          color: '#4ade80',
                        }}>PART MATCH</span>
                      )}
                    </div>
                    <div style={{ fontSize: '11px', color: '#dce6f0', marginTop: '2px' }}>
                      {po.customer}{lineCount > 0 ? ` · ${lineCount} items` : ''}
                      {totalValue > 0 ? ` · $${totalValue.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}` : ''}
                    </div>
                    {/* Show line items summary */}
                    {po.po_line_items && po.po_line_items.length > 0 && (
                      <div style={{ marginTop: '6px' }}>
                        {po.po_line_items.slice(0, 3).map((li) => (
                          <div key={li.id} style={{
                            fontSize: '10px', color: '#e8f0f8', marginTop: '2px',
                            display: 'flex', gap: '6px', alignItems: 'center',
                          }}>
                            <span style={{
                              color: li.part_number?.toLowerCase() === vehiclePartNumber?.toLowerCase() ? '#4ade80' : '#dce6f0',
                              fontWeight: li.part_number?.toLowerCase() === vehiclePartNumber?.toLowerCase() ? 700 : 400,
                            }}>
                              {li.part_number}
                            </span>
                            <span>·</span>
                            <span>{li.installed}/{li.quantity} installed</span>
                          </div>
                        ))}
                        {po.po_line_items.length > 3 && (
                          <div style={{ fontSize: '10px', color: '#3a4a5d', marginTop: '2px' }}>
                            +{po.po_line_items.length - 3} more items
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <button
                    onClick={() => handleAssign(po)}
                    disabled={isAssigning}
                    style={{
                      padding: '8px 16px', borderRadius: '10px', border: 'none',
                      background: matchingLine ? 'rgba(74,222,128,0.15)' : hasCapacity ? 'rgba(96,165,250,0.12)' : 'rgba(251,191,36,0.1)',
                      color: matchingLine ? '#4ade80' : hasCapacity ? '#60a5fa' : '#fbbf24',
                      fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                      opacity: isAssigning ? 0.5 : 1,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {isAssigning ? 'Assigning...' : 'Assign'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
