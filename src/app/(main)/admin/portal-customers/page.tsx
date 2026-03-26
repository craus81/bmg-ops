'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import type { PortalCustomer } from '@/lib/types';

const appUrl = typeof window !== 'undefined' ? window.location.origin : '';

export default function PortalCustomersPage() {
  const router = useRouter();
  const { isAdmin, isSales } = useAuth();

  const [customers, setCustomers] = useState<PortalCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [newName, setNewName] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [newColor, setNewColor] = useState('#EE3120');

  useEffect(() => {
    if (!isAdmin && !isSales) { router.push('/home'); return; }
    loadCustomers();
  }, [isAdmin, isSales]);

  const loadCustomers = async () => {
    setLoading(true);
    const res = await fetch('/api/admin/portal-customers');
    const data = await res.json();
    setCustomers(Array.isArray(data) ? data : []);
    setLoading(false);
  };

  const handleNameChange = (val: string) => {
    setNewName(val);
    // Auto-generate slug from company name
    const slug = val.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    setNewSlug(slug);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newSlug.trim()) return;
    setSaving(true); setError('');
    const res = await fetch('/api/admin/portal-customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_name: newName.trim(), slug: newSlug.trim(), primary_color: newColor }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) { setError(data.error || 'Failed to create'); return; }
    setNewName(''); setNewSlug(''); setNewColor('#EE3120');
    setShowForm(false);
    loadCustomers();
  };

  const cardStyle: React.CSSProperties = {
    background: 'var(--card)', border: '1px solid var(--border)',
    borderRadius: '14px', padding: '16px 20px',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    cursor: 'pointer', transition: 'border-color 0.15s',
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '12px 16px', borderRadius: '10px',
    border: '1px solid var(--border)', background: 'var(--input-bg, var(--card))',
    color: 'var(--text-primary)', fontSize: '15px', marginBottom: '10px',
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
        <div>
          <h1 style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>Portal Customers</h1>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: '4px 0 0' }}>
            Manage customer-facing graphics ordering portals
          </p>
        </div>
        <button
          onClick={() => { setShowForm(true); setError(''); }}
          style={{
            padding: '10px 18px', borderRadius: '10px', background: 'var(--orange)',
            color: '#fff', fontSize: '14px', fontWeight: 700, border: 'none',
          }}
        >
          + New Portal
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '20px', marginBottom: '20px' }}>
          <div style={{ fontWeight: 700, fontSize: '16px', color: 'var(--text-primary)', marginBottom: '14px' }}>
            New Portal Customer
          </div>
          <form onSubmit={handleCreate}>
            <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px', display: 'block', marginBottom: '6px' }}>
              Company Name
            </label>
            <input
              value={newName}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="e.g. Verizon Fleet"
              style={inputStyle}
              required
            />
            <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px', display: 'block', marginBottom: '6px' }}>
              URL Slug
            </label>
            <input
              value={newSlug}
              onChange={(e) => setNewSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              placeholder="e.g. verizon-fleet"
              style={inputStyle}
              required
            />
            {newSlug && (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '-6px', marginBottom: '12px' }}>
                Portal URL: <span style={{ color: 'var(--text-secondary)' }}>/portal/{newSlug}</span>
              </div>
            )}
            <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px', display: 'block', marginBottom: '6px' }}>
              Brand Color (optional)
            </label>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '14px' }}>
              <input
                type="color"
                value={newColor}
                onChange={(e) => setNewColor(e.target.value)}
                style={{ width: '48px', height: '40px', border: 'none', borderRadius: '8px', cursor: 'pointer', padding: 0 }}
              />
              <input
                value={newColor}
                onChange={(e) => setNewColor(e.target.value)}
                placeholder="#EE3120"
                style={{ ...inputStyle, marginBottom: 0, width: '140px' }}
              />
            </div>
            {error && (
              <div style={{ padding: '10px 14px', background: 'var(--error-bg)', border: '1px solid var(--error-border)', borderRadius: '8px', color: 'var(--error)', fontSize: '13px', marginBottom: '12px' }}>
                {error}
              </div>
            )}
            <div style={{ display: 'flex', gap: '10px' }}>
              <button type="submit" disabled={saving || !newName || !newSlug} style={{
                flex: 1, padding: '12px', borderRadius: '10px', background: 'var(--orange)',
                color: '#fff', fontWeight: 700, fontSize: '14px', opacity: saving || !newName || !newSlug ? 0.5 : 1,
              }}>
                {saving ? 'Creating...' : 'Create Portal'}
              </button>
              <button type="button" onClick={() => { setShowForm(false); setError(''); }} style={{
                padding: '12px 20px', borderRadius: '10px', border: '1px solid var(--border)',
                background: 'transparent', color: 'var(--text-muted)', fontWeight: 600, fontSize: '14px',
              }}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Customer list */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>
      ) : customers.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '32px', marginBottom: '12px' }}>🏢</div>
          <div style={{ fontWeight: 600, marginBottom: '6px' }}>No portal customers yet</div>
          <div style={{ fontSize: '13px' }}>Create one above to get started</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {customers.map((c) => (
            <div
              key={c.id}
              style={cardStyle}
              onClick={() => router.push(`/admin/portal-customers/${c.id}`)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                {c.logo_url ? (
                  <img src={c.logo_url} alt={c.company_name} style={{ width: '40px', height: '40px', objectFit: 'contain', borderRadius: '8px', background: 'var(--bg)' }} />
                ) : (
                  <div style={{
                    width: '40px', height: '40px', borderRadius: '8px',
                    background: c.primary_color || 'var(--navy)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '18px', fontWeight: 800, color: '#fff',
                  }}>
                    {c.company_name.charAt(0)}
                  </div>
                )}
                <div>
                  <div style={{ fontWeight: 700, fontSize: '15px', color: 'var(--text-primary)' }}>{c.company_name}</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    /portal/{c.slug}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                {c.primary_color && (
                  <div style={{ width: '20px', height: '20px', borderRadius: '50%', background: c.primary_color, border: '2px solid var(--border)' }} />
                )}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2.5">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
