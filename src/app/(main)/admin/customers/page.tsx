'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

interface Customer {
  id: string;
  netsuite_id: string | null;
  company_name: string;
  entity_id: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
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
  const { isAdmin } = useAuth();
  const supabase = createClient();

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [expandedCustomer, setExpandedCustomer] = useState<string | null>(null);

  // Add/edit contact state
  const [showAddContact, setShowAddContact] = useState<string | null>(null); // customer_id
  const [editingContact, setEditingContact] = useState<string | null>(null);
  const [contactForm, setContactForm] = useState(emptyContact);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    loadData();
  }, [isAdmin]);

  const loadData = async () => {
    const [custRes, contRes] = await Promise.all([
      supabase.from('customers').select('*').eq('active', true).order('company_name'),
      supabase.from('contacts').select('*').order('name'),
    ]);
    setCustomers((custRes.data as Customer[]) || []);
    setContacts((contRes.data as Contact[]) || []);
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
        setSyncResult(`Synced ${data.synced} of ${data.total} customers from NetSuite`);
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

  const filteredCustomers = customers.filter(c => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    if (c.company_name.toLowerCase().includes(q)) return true;
    if (c.entity_id?.toLowerCase().includes(q)) return true;
    if (c.email?.toLowerCase().includes(q)) return true;
    // Also search contacts
    const custContacts = contacts.filter(ct => ct.customer_id === c.id);
    if (custContacts.some(ct =>
      ct.name.toLowerCase().includes(q) ||
      ct.email?.toLowerCase().includes(q) ||
      ct.phone?.toLowerCase().includes(q)
    )) return true;
    return false;
  });

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid #1e2d3d',
    background: '#0a1018', color: '#e8ecf1', fontSize: '13px', outline: 'none',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: '10px', fontWeight: 700, color: '#4a5f78',
    marginBottom: '3px', textTransform: 'uppercase', letterSpacing: '0.05em',
  };

  if (loading) {
    return <div style={{ padding: '24px', textAlign: 'center', color: '#4a5f78' }}>Loading...</div>;
  }

  return (
    <div style={{ padding: '16px', maxWidth: '800px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div>
          <h1 style={{ fontSize: '20px', fontWeight: 800, color: '#e8ecf1', margin: 0 }}>Customers & Contacts</h1>
          <div style={{ fontSize: '12px', color: '#4a5f78', marginTop: '2px' }}>{customers.length} customers · {contacts.length} contacts</div>
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

      {/* Search */}
      <input
        type="text"
        placeholder="Search customers, contacts..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{ ...inputStyle, marginBottom: '12px' }}
      />

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
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: '#e8ecf1' }}>
                    {customer.company_name}
                  </div>
                  <div style={{ fontSize: '11px', color: '#4a5f78', marginTop: '2px' }}>
                    {customer.entity_id && <span>{customer.entity_id} · </span>}
                    {customer.email && <span>{customer.email} · </span>}
                    {customer.phone && <span>{customer.phone} · </span>}
                    {custContacts.length} contact{custContacts.length !== 1 ? 's' : ''}
                  </div>
                </div>
                <div style={{ fontSize: '16px', color: '#4a5f78', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>
                  ▾
                </div>
              </div>

              {/* Expanded: contacts */}
              {isExpanded && (
                <div style={{ padding: '0 14px 14px 14px', borderTop: '1px solid #1e2d3d' }}>
                  {/* Customer details */}
                  {customer.address && (
                    <div style={{ fontSize: '11px', color: '#6b7a8d', padding: '8px 0', borderBottom: '1px solid rgba(30,45,61,0.5)' }}>
                      {customer.address}
                    </div>
                  )}

                  {/* Contacts list */}
                  {custContacts.length > 0 ? (
                    <div style={{ marginTop: '8px' }}>
                      <div style={{ fontSize: '10px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', marginBottom: '6px' }}>Contacts</div>
                      {custContacts.map(contact => (
                        <div key={contact.id} style={{
                          padding: '8px 10px', borderRadius: '6px', background: 'rgba(59,130,246,0.05)',
                          border: '1px solid rgba(59,130,246,0.1)', marginBottom: '4px',
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <div>
                              <div style={{ fontSize: '13px', fontWeight: 700, color: '#e8ecf1' }}>
                                {contact.name}
                                {contact.title && <span style={{ fontSize: '11px', fontWeight: 400, color: '#6b7a8d', marginLeft: '8px' }}>{contact.title}</span>}
                              </div>
                              <div style={{ fontSize: '11px', color: '#4a5f78', marginTop: '2px' }}>
                                {contact.email && <span>{contact.email}</span>}
                                {contact.email && contact.phone && <span> · </span>}
                                {contact.phone && <span>{contact.phone}</span>}
                              </div>
                              {contact.address && (
                                <div style={{ fontSize: '11px', color: '#4a5f78', marginTop: '1px' }}>{contact.address}</div>
                              )}
                              {contact.notes && (
                                <div style={{ fontSize: '11px', color: '#6b7a8d', marginTop: '2px', fontStyle: 'italic' }}>{contact.notes}</div>
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
                    <div style={{ fontSize: '11px', color: '#4a5f78', padding: '12px 0' }}>No contacts yet</div>
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
                          style={{ padding: '6px 12px', borderRadius: '6px', background: '#1e2d3d', border: 'none', color: '#6b7a8d', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
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
        <div style={{ textAlign: 'center', padding: '32px', color: '#4a5f78' }}>
          {customers.length === 0
            ? <div><div style={{ fontSize: '14px', marginBottom: '8px' }}>No customers yet</div><div style={{ fontSize: '12px' }}>Click "Sync from NetSuite" to import your customer list</div></div>
            : <div style={{ fontSize: '13px' }}>No customers match "{search}"</div>
          }
        </div>
      )}
    </div>
  );
}
