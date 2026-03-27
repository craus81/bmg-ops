'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

interface Customer {
  id: string;
  netsuite_id: string | null;
  netsuite_url: string | null;
  company_name: string;
  entity_id: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  total_orders: number;
  total_spend: number;
  avg_order_value: number;
  ytd_spend: number;
  ytd_orders: number;
  last_year_spend: number;
  last_year_orders: number;
  last_order_date: string | null;
  active: boolean;
  created_at: string;
}

interface Contact {
  id: string;
  customer_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  address: string | null;
  notes: string | null;
  created_at: string;
}

const emptyContact = { name: '', email: '', phone: '', title: '', address: '', notes: '' };

export default function CustomersPage() {
  const router = useRouter();
  const { isAdmin, isSales } = useAuth();
  const supabase = createClient();

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'spend' | 'orders' | 'recent'>('name');

  // Purchase report state
  const [reportCustomer, setReportCustomer] = useState<string | null>(null);
  const [reportStartDate, setReportStartDate] = useState(() => `${new Date().getFullYear()}-01-01`);
  const [reportEndDate, setReportEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [generatingReport, setGeneratingReport] = useState(false);
  const [expandedCustomer, setExpandedCustomer] = useState<string | null>(null);

  // Add/edit contact state
  const [showAddContact, setShowAddContact] = useState<string | null>(null); // customer_id
  const [editingContact, setEditingContact] = useState<string | null>(null);
  const [contactForm, setContactForm] = useState(emptyContact);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isAdmin && !isSales) { router.push('/home'); return; }
    loadData();
  }, [isAdmin, isSales]);

  const loadData = async () => {
    // Supabase returns max 1000 rows by default — paginate to get all customers
    let allCustomers: Customer[] = [];
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;
    while (hasMore) {
      const from = page * pageSize;
      const to = from + pageSize - 1;
      const { data } = await supabase
        .from('customers')
        .select('*')
        .eq('active', true)
        .order('company_name')
        .range(from, to);
      const batch = (data || []) as Customer[];
      allCustomers = allCustomers.concat(batch);
      hasMore = batch.length === pageSize;
      page++;
    }

    const { data: contData } = await supabase.from('contacts').select('*').order('name');
    setCustomers(allCustomers);
    setContacts((contData as Contact[]) || []);
    setLoading(false);
  };

  const syncFromNetSuite = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch('/api/netsuite/customers');
      const data = await res.json();
      if (!res.ok || data.error) {
        setSyncResult(`Error: ${data.error || 'Sync failed'}`);
      } else {
        const msg = `Synced ${data.synced} of ${data.total} customers from NetSuite`;
        setSyncResult(data.firstError ? `${msg} (errors: ${data.firstError})` : msg);
        await loadData();
      }
    } catch (err: any) {
      setSyncResult(`Error: ${err.message || 'Network error'}`);
    }
    setSyncing(false);
  };

  const saveContact = async (customerId: string) => {
    if (!contactForm.name.trim()) return;
    setSaving(true);

    if (editingContact) {
      // Update
      const res = await fetch('/api/contacts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editingContact, ...contactForm }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to update');
      } else {
        setContacts(prev => prev.map(c => c.id === editingContact ? data : c));
      }
    } else {
      // Create
      const res = await fetch('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: customerId, ...contactForm }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to create');
      } else {
        setContacts(prev => [...prev, data]);
      }
    }

    setSaving(false);
    setShowAddContact(null);
    setEditingContact(null);
    setContactForm(emptyContact);
  };

  const deleteContact = async (id: string) => {
    if (!window.confirm('Delete this contact?')) return;
    const res = await fetch('/api/contacts', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (res.ok) {
      setContacts(prev => prev.filter(c => c.id !== id));
    }
  };

  const generatePurchaseReport = async (customer: Customer) => {
    setGeneratingReport(true);
    try {
      const params = new URLSearchParams({
        customerId: customer.netsuite_id || '',
        startDate: reportStartDate,
        endDate: reportEndDate,
      });
      const res = await fetch(`/api/netsuite/customer-purchases?${params}`);
      const data = await res.json();

      if (!res.ok || data.error) {
        alert(data.error || 'Failed to fetch purchase data');
        setGeneratingReport(false);
        return;
      }

      const { lines, summary } = data;

      // Generate PDF
      const doc = new jsPDF();
      const pageWidth = doc.internal.pageSize.getWidth();

      // Header
      doc.setFontSize(18);
      doc.setFont('helvetica', 'bold');
      doc.text('Customer Purchase Report', 14, 20);

      doc.setFontSize(11);
      doc.setFont('helvetica', 'normal');
      doc.text(customer.company_name, 14, 28);

      doc.setFontSize(9);
      doc.setTextColor(100);
      const startFormatted = new Date(reportStartDate + 'T00:00:00').toLocaleDateString();
      const endFormatted = new Date(reportEndDate + 'T00:00:00').toLocaleDateString();
      doc.text(`${startFormatted} — ${endFormatted}`, 14, 34);
      doc.text(`Generated ${new Date().toLocaleDateString()}`, 14, 39);

      // Summary box
      doc.setDrawColor(200);
      doc.setFillColor(245, 247, 250);
      doc.roundedRect(14, 44, pageWidth - 28, 18, 2, 2, 'FD');

      doc.setTextColor(0);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      const summaryY = 53;
      const colW = (pageWidth - 28) / 4;
      doc.text(`Total Spend`, 20, summaryY - 3);
      doc.text(`$${summary.totalSpend.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`, 20, summaryY + 2);

      doc.text(`Orders`, 20 + colW, summaryY - 3);
      doc.text(`${summary.uniqueOrders}`, 20 + colW, summaryY + 2);

      doc.text(`Unique Items`, 20 + colW * 2, summaryY - 3);
      doc.text(`${summary.uniqueItems}`, 20 + colW * 2, summaryY + 2);

      doc.text(`Avg Order`, 20 + colW * 3, summaryY - 3);
      doc.text(`$${summary.avgOrderValue.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`, 20 + colW * 3, summaryY + 2);

      // Table
      if (lines.length > 0) {
        autoTable(doc, {
          startY: 68,
          head: [['Date', 'SO #', 'PO #', 'Item', 'Qty', 'Rate', 'Total']],
          body: lines.map((l: any) => [
            l.orderDate ? new Date(l.orderDate + 'T00:00:00').toLocaleDateString() : '',
            l.soNumber,
            l.poNumber,
            l.itemName,
            l.quantity.toString(),
            `$${l.rate.toFixed(2)}`,
            `$${l.lineTotal.toFixed(2)}`,
          ]),
          styles: { fontSize: 8, cellPadding: 2 },
          headStyles: { fillColor: [59, 130, 246], textColor: 255, fontStyle: 'bold' },
          alternateRowStyles: { fillColor: [245, 247, 250] },
          columnStyles: {
            0: { cellWidth: 22 },
            4: { halign: 'right', cellWidth: 14 },
            5: { halign: 'right', cellWidth: 20 },
            6: { halign: 'right', cellWidth: 22 },
          },
        });
      } else {
        doc.setFontSize(11);
        doc.setTextColor(150);
        doc.text('No purchase data found for this date range.', 14, 75);
      }

      // Footer on each page
      const totalPages = (doc as any).internal.getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);
        doc.setFontSize(7);
        doc.setTextColor(150);
        doc.text(
          `BMG FleetSuite — ${customer.company_name} — Page ${i} of ${totalPages}`,
          pageWidth / 2, doc.internal.pageSize.getHeight() - 8,
          { align: 'center' }
        );
      }

      // Download
      doc.save(`${customer.company_name.replace(/[^a-zA-Z0-9]/g, '_')}_purchases_${reportStartDate}_${reportEndDate}.pdf`);
    } catch (err: any) {
      alert(err.message || 'Failed to generate report');
    }
    setGeneratingReport(false);
  };

  const startEditContact = (contact: Contact) => {
    setEditingContact(contact.id);
    setShowAddContact(contact.customer_id);
    setContactForm({
      name: contact.name,
      email: contact.email || '',
      phone: contact.phone || '',
      title: contact.title || '',
      address: contact.address || '',
      notes: contact.notes || '',
    });
  };

  const fmt = (n: number) => '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fmtK = (n: number) => n >= 1000 ? '$' + (n / 1000).toFixed(1) + 'k' : fmt(n);

  const filteredCustomers = customers
    .filter(c => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      if (c.company_name.toLowerCase().includes(q)) return true;
      if (c.entity_id?.toLowerCase().includes(q)) return true;
      if (c.email?.toLowerCase().includes(q)) return true;
      const custContacts = contacts.filter(ct => ct.customer_id === c.id);
      if (custContacts.some(ct =>
        ct.name.toLowerCase().includes(q) ||
        ct.email?.toLowerCase().includes(q) ||
        ct.phone?.toLowerCase().includes(q)
      )) return true;
      return false;
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'spend': return (b.total_spend || 0) - (a.total_spend || 0);
        case 'orders': return (b.total_orders || 0) - (a.total_orders || 0);
        case 'recent': return (b.last_order_date || '').localeCompare(a.last_order_date || '');
        default: return a.company_name.localeCompare(b.company_name);
      }
    });

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid #1e2d3d',
    background: '#0a1018', color: '#f5f8fc', fontSize: '13px', outline: 'none',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: '10px', fontWeight: 700, color: '#d0dcea',
    marginBottom: '3px', textTransform: 'uppercase', letterSpacing: '0.05em',
  };

  if (loading) {
    return <div style={{ padding: '24px', textAlign: 'center', color: '#d0dcea' }}>Loading...</div>;
  }

  return (
    <div style={{ padding: '16px', maxWidth: '800px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div>
          <h1 style={{ fontSize: '20px', fontWeight: 800, color: '#f5f8fc', margin: 0 }}>Customers & Contacts</h1>
          <div style={{ fontSize: '12px', color: '#d0dcea', marginTop: '2px' }}>{customers.length} customers · {contacts.length} contacts</div>
        </div>
        <button
          onClick={syncFromNetSuite}
          disabled={syncing}
          style={{
            padding: '8px 16px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
            background: syncing ? '#1e2d3d' : '#3b82f6', border: 'none', color: '#fff', cursor: 'pointer',
          }}
        >
          {syncing ? 'Syncing...' : 'Sync from NetSuite'}
        </button>
      </div>

      {syncResult && (
        <div style={{
          padding: '8px 12px', borderRadius: '6px', marginBottom: '12px', fontSize: '12px',
          background: syncResult.startsWith('Error') ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)',
          color: syncResult.startsWith('Error') ? '#ef4444' : '#4ade80',
          border: `1px solid ${syncResult.startsWith('Error') ? 'rgba(239,68,68,0.2)' : 'rgba(34,197,94,0.2)'}`,
        }}>
          {syncResult}
        </div>
      )}

      {/* Search + Sort */}
      <input
        type="text"
        placeholder="Search customers, contacts..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{ ...inputStyle, marginBottom: '8px' }}
      />
      <div style={{ display: 'flex', gap: '4px', marginBottom: '12px' }}>
        {([
          ['name', 'A-Z'],
          ['spend', 'Top Spend'],
          ['orders', 'Most Orders'],
          ['recent', 'Recent'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setSortBy(key)}
            style={{
              padding: '4px 10px', borderRadius: '5px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
              background: sortBy === key ? '#3b82f6' : 'rgba(59,130,246,0.1)',
              border: sortBy === key ? 'none' : '1px solid rgba(59,130,246,0.2)',
              color: sortBy === key ? '#fff' : '#60a5fa',
            }}
          >{label}</button>
        ))}
      </div>

      {/* Customer list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {filteredCustomers.map(customer => {
          const isExpanded = expandedCustomer === customer.id;
          const custContacts = contacts.filter(c => c.customer_id === customer.id);
          const isAddingContact = showAddContact === customer.id;

          return (
            <div key={customer.id} style={{
              borderRadius: '10px', border: '1px solid #1e2d3d', background: '#0f1720', overflow: 'hidden',
            }}>
              {/* Customer header */}
              <div
                onClick={() => {
                  setExpandedCustomer(isExpanded ? null : customer.id);
                  setShowAddContact(null);
                  setEditingContact(null);
                  setContactForm(emptyContact);
                }}
                style={{
                  padding: '12px 14px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: '#f5f8fc' }}>
                    {customer.company_name}
                  </div>
                  <div style={{ fontSize: '11px', color: '#d0dcea', marginTop: '2px' }}>
                    {customer.entity_id && <span>{customer.entity_id} · </span>}
                    {customer.email && <span>{customer.email} · </span>}
                    {customer.phone && <span>{customer.phone} · </span>}
                    {custContacts.length} contact{custContacts.length !== 1 ? 's' : ''}
                  </div>
                </div>
                {/* Spend metrics - compact */}
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexShrink: 0 }}>
                  {(customer.ytd_spend > 0) && (
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '13px', fontWeight: 800, color: '#4ade80' }}>{fmtK(customer.ytd_spend)}</div>
                      <div style={{ fontSize: '9px', color: '#d0dcea', textTransform: 'uppercase' }}>YTD</div>
                    </div>
                  )}
                  {(customer.total_spend > 0) && (
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '13px', fontWeight: 800, color: '#60a5fa' }}>{fmtK(customer.total_spend)}</div>
                      <div style={{ fontSize: '9px', color: '#d0dcea', textTransform: 'uppercase' }}>All-Time</div>
                    </div>
                  )}
                  {(customer.total_orders > 0) && (
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '13px', fontWeight: 800, color: '#fbbf24' }}>{customer.total_orders}</div>
                      <div style={{ fontSize: '9px', color: '#d0dcea', textTransform: 'uppercase' }}>Orders</div>
                    </div>
                  )}
                  <div style={{ fontSize: '16px', color: '#d0dcea', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>
                    ▾
                  </div>
                </div>
              </div>

              {/* Expanded: contacts */}
              {isExpanded && (
                <div style={{ padding: '0 14px 14px 14px', borderTop: '1px solid #1e2d3d' }}>
                  {/* Spend breakdown */}
                  {(customer.total_spend > 0 || customer.ytd_spend > 0) && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', padding: '10px 0', borderBottom: '1px solid rgba(30,45,61,0.5)' }}>
                      <div style={{ textAlign: 'center', padding: '8px', borderRadius: '6px', background: 'rgba(34,197,94,0.08)' }}>
                        <div style={{ fontSize: '15px', fontWeight: 800, color: '#4ade80' }}>{fmtK(customer.ytd_spend || 0)}</div>
                        <div style={{ fontSize: '9px', color: '#d0dcea', textTransform: 'uppercase', marginTop: '2px' }}>YTD Spend</div>
                        {customer.ytd_orders > 0 && <div style={{ fontSize: '9px', color: '#dce6f0' }}>{customer.ytd_orders} orders</div>}
                      </div>
                      <div style={{ textAlign: 'center', padding: '8px', borderRadius: '6px', background: 'rgba(251,191,36,0.08)' }}>
                        <div style={{ fontSize: '15px', fontWeight: 800, color: '#fbbf24' }}>{fmtK(customer.last_year_spend || 0)}</div>
                        <div style={{ fontSize: '9px', color: '#d0dcea', textTransform: 'uppercase', marginTop: '2px' }}>Last Year</div>
                        {customer.last_year_orders > 0 && <div style={{ fontSize: '9px', color: '#dce6f0' }}>{customer.last_year_orders} orders</div>}
                      </div>
                      <div style={{ textAlign: 'center', padding: '8px', borderRadius: '6px', background: 'rgba(59,130,246,0.08)' }}>
                        <div style={{ fontSize: '15px', fontWeight: 800, color: '#60a5fa' }}>{fmtK(customer.total_spend || 0)}</div>
                        <div style={{ fontSize: '9px', color: '#d0dcea', textTransform: 'uppercase', marginTop: '2px' }}>All-Time</div>
                        {customer.total_orders > 0 && <div style={{ fontSize: '9px', color: '#dce6f0' }}>{customer.total_orders} orders</div>}
                      </div>
                      <div style={{ textAlign: 'center', padding: '8px', borderRadius: '6px', background: 'rgba(168,85,247,0.08)' }}>
                        <div style={{ fontSize: '15px', fontWeight: 800, color: '#a855f7' }}>{fmtK(customer.avg_order_value || 0)}</div>
                        <div style={{ fontSize: '9px', color: '#d0dcea', textTransform: 'uppercase', marginTop: '2px' }}>Avg Order</div>
                      </div>
                    </div>
                  )}

                  {/* Customer details */}
                  <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', padding: '8px 0', borderBottom: '1px solid rgba(30,45,61,0.5)', fontSize: '11px', color: '#dce6f0', alignItems: 'center' }}>
                    {customer.address && <span>{customer.address}</span>}
                    {customer.last_order_date && (
                      <span>Last order: <strong style={{ color: '#94a3b8' }}>{new Date(customer.last_order_date).toLocaleDateString()}</strong></span>
                    )}
                    {customer.netsuite_url && (
                      <a
                        href={customer.netsuite_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        style={{ color: '#d0dcea', textDecoration: 'none', fontWeight: 600, fontSize: '10px' }}
                      >
                        NetSuite ↗
                      </a>
                    )}
                  </div>

                  {/* Purchase Report */}
                  {customer.netsuite_id && (
                    <div style={{ padding: '10px 0', borderBottom: '1px solid rgba(30,45,61,0.5)' }}>
                      <div style={{ fontSize: '10px', fontWeight: 700, color: '#d0dcea', textTransform: 'uppercase', marginBottom: '6px' }}>Purchase Report</div>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <label style={{ fontSize: '10px', color: '#dce6f0' }}>From</label>
                          <input
                            type="date"
                            value={reportCustomer === customer.id ? reportStartDate : `${new Date().getFullYear()}-01-01`}
                            onClick={(e) => { e.stopPropagation(); setReportCustomer(customer.id); }}
                            onChange={(e) => { setReportCustomer(customer.id); setReportStartDate(e.target.value); }}
                            style={{
                              padding: '4px 8px', borderRadius: '5px', border: '1px solid #1e2d3d',
                              background: '#0a1018', color: '#f5f8fc', fontSize: '11px', outline: 'none',
                            }}
                          />
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <label style={{ fontSize: '10px', color: '#dce6f0' }}>To</label>
                          <input
                            type="date"
                            value={reportCustomer === customer.id ? reportEndDate : new Date().toISOString().slice(0, 10)}
                            onClick={(e) => { e.stopPropagation(); setReportCustomer(customer.id); }}
                            onChange={(e) => { setReportCustomer(customer.id); setReportEndDate(e.target.value); }}
                            style={{
                              padding: '4px 8px', borderRadius: '5px', border: '1px solid #1e2d3d',
                              background: '#0a1018', color: '#f5f8fc', fontSize: '11px', outline: 'none',
                            }}
                          />
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (reportCustomer !== customer.id) {
                              setReportCustomer(customer.id);
                              setReportStartDate(`${new Date().getFullYear()}-01-01`);
                              setReportEndDate(new Date().toISOString().slice(0, 10));
                            }
                            generatePurchaseReport(customer);
                          }}
                          disabled={generatingReport}
                          style={{
                            padding: '5px 14px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                            background: generatingReport ? '#1e2d3d' : 'rgba(59,130,246,0.15)',
                            border: '1px solid rgba(59,130,246,0.3)', color: generatingReport ? '#d0dcea' : '#60a5fa',
                            cursor: generatingReport ? 'not-allowed' : 'pointer',
                          }}
                        >
                          {generatingReport && reportCustomer === customer.id ? 'Generating...' : '📄 Download Report'}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Contacts list */}
                  {custContacts.length > 0 ? (
                    <div style={{ marginTop: '8px' }}>
                      <div style={{ fontSize: '10px', fontWeight: 700, color: '#d0dcea', textTransform: 'uppercase', marginBottom: '6px' }}>Contacts</div>
                      {custContacts.map(contact => (
                        <div key={contact.id} style={{
                          padding: '8px 10px', borderRadius: '6px', background: 'rgba(59,130,246,0.05)',
                          border: '1px solid rgba(59,130,246,0.1)', marginBottom: '4px',
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <div>
                              <div style={{ fontSize: '13px', fontWeight: 700, color: '#f5f8fc' }}>
                                {contact.name}
                                {contact.title && <span style={{ fontSize: '11px', fontWeight: 400, color: '#dce6f0', marginLeft: '8px' }}>{contact.title}</span>}
                              </div>
                              <div style={{ fontSize: '11px', color: '#d0dcea', marginTop: '2px' }}>
                                {contact.email && <span>{contact.email}</span>}
                                {contact.email && contact.phone && <span> · </span>}
                                {contact.phone && <span>{contact.phone}</span>}
                              </div>
                              {contact.address && (
                                <div style={{ fontSize: '11px', color: '#d0dcea', marginTop: '1px' }}>{contact.address}</div>
                              )}
                              {contact.notes && (
                                <div style={{ fontSize: '11px', color: '#dce6f0', marginTop: '2px', fontStyle: 'italic' }}>{contact.notes}</div>
                              )}
                            </div>
                            <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                              <button
                                onClick={(e) => { e.stopPropagation(); startEditContact(contact); }}
                                style={{ background: 'none', border: 'none', color: '#3b82f6', fontSize: '11px', cursor: 'pointer', fontWeight: 600 }}
                              >Edit</button>
                              <button
                                onClick={(e) => { e.stopPropagation(); deleteContact(contact.id); }}
                                style={{ background: 'none', border: 'none', color: '#f87171', fontSize: '11px', cursor: 'pointer', fontWeight: 600 }}
                              >Delete</button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: '11px', color: '#d0dcea', padding: '12px 0' }}>No contacts yet</div>
                  )}

                  {/* Add/Edit contact form */}
                  {isAddingContact ? (
                    <div style={{ marginTop: '8px', padding: '10px', borderRadius: '8px', background: 'rgba(59,130,246,0.05)', border: '1px solid rgba(59,130,246,0.15)' }}>
                      <div style={{ fontSize: '11px', fontWeight: 700, color: '#60a5fa', marginBottom: '8px' }}>
                        {editingContact ? 'Edit Contact' : 'Add Contact'}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                        <div>
                          <label style={labelStyle}>Name *</label>
                          <input
                            style={inputStyle}
                            value={contactForm.name}
                            onChange={e => setContactForm(f => ({ ...f, name: e.target.value }))}
                            placeholder="Full name"
                          />
                        </div>
                        <div>
                          <label style={labelStyle}>Title / Role</label>
                          <input
                            style={inputStyle}
                            value={contactForm.title}
                            onChange={e => setContactForm(f => ({ ...f, title: e.target.value }))}
                            placeholder="e.g. Purchasing Manager"
                          />
                        </div>
                        <div>
                          <label style={labelStyle}>Email</label>
                          <input
                            style={inputStyle}
                            value={contactForm.email}
                            onChange={e => setContactForm(f => ({ ...f, email: e.target.value }))}
                            placeholder="email@example.com"
                          />
                        </div>
                        <div>
                          <label style={labelStyle}>Phone</label>
                          <input
                            style={inputStyle}
                            value={contactForm.phone}
                            onChange={e => setContactForm(f => ({ ...f, phone: e.target.value }))}
                            placeholder="(555) 123-4567"
                          />
                        </div>
                        <div style={{ gridColumn: '1 / -1' }}>
                          <label style={labelStyle}>Address</label>
                          <input
                            style={inputStyle}
                            value={contactForm.address}
                            onChange={e => setContactForm(f => ({ ...f, address: e.target.value }))}
                            placeholder="Full address"
                          />
                        </div>
                        <div style={{ gridColumn: '1 / -1' }}>
                          <label style={labelStyle}>Notes</label>
                          <input
                            style={inputStyle}
                            value={contactForm.notes}
                            onChange={e => setContactForm(f => ({ ...f, notes: e.target.value }))}
                            placeholder="Any additional notes..."
                          />
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '6px', marginTop: '8px', justifyContent: 'flex-end' }}>
                        <button
                          onClick={() => { setShowAddContact(null); setEditingContact(null); setContactForm(emptyContact); }}
                          style={{ padding: '6px 12px', borderRadius: '6px', background: '#1e2d3d', border: 'none', color: '#dce6f0', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
                        >Cancel</button>
                        <button
                          onClick={() => saveContact(customer.id)}
                          disabled={saving || !contactForm.name.trim()}
                          style={{
                            padding: '6px 14px', borderRadius: '6px', border: 'none', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                            background: saving ? '#1e2d3d' : '#3b82f6', color: '#fff',
                          }}
                        >{saving ? 'Saving...' : editingContact ? 'Update' : 'Add Contact'}</button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); setShowAddContact(customer.id); setEditingContact(null); setContactForm(emptyContact); }}
                      style={{
                        marginTop: '8px', padding: '6px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                        background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)', color: '#4ade80', cursor: 'pointer',
                      }}
                    >+ Add Contact</button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {filteredCustomers.length === 0 && (
        <div style={{ textAlign: 'center', padding: '32px', color: '#d0dcea' }}>
          {customers.length === 0
            ? <div><div style={{ fontSize: '14px', marginBottom: '8px' }}>No customers yet</div><div style={{ fontSize: '12px' }}>Click "Sync from NetSuite" to import your customer list</div></div>
            : <div style={{ fontSize: '13px' }}>No customers match "{search}"</div>
          }
        </div>
      )}
    </div>
  );
}
