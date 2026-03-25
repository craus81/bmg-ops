'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';

interface UserOption {
  id: string;
  full_name: string;
  role: string;
}

interface AssignmentPickerProps {
  jobType: 'scanned_vehicle' | 'graphics_job';
  jobId?: string; // If provided, loads existing assignments
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  roles?: string[]; // Filter to specific roles
  label?: string;
  compact?: boolean;
}

const ROLE_COLORS: Record<string, string> = {
  admin: 'var(--orange)',
  installer: 'var(--text-muted)',
  production: '#c084fc',
  sales: '#60a5fa',
};

export default function AssignmentPicker({
  jobType,
  jobId,
  selectedIds,
  onChange,
  roles,
  label,
  compact = false,
}: AssignmentPickerProps) {
  const supabase = createClient();
  const [users, setUsers] = useState<UserOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [showPicker, setShowPicker] = useState(false);

  useEffect(() => {
    loadUsers();
  }, []);

  const loadUsers = async () => {
    let query = supabase
      .from('profiles')
      .select('id, full_name, role')
      .eq('status', 'approved')
      .order('full_name');

    if (roles && roles.length > 0) {
      query = query.in('role', roles);
    } else {
      // Default: show installers, production, and admin
      query = query.in('role', ['admin', 'installer', 'field_tech', 'shop_tech', 'graphics_production', 'production']);
    }

    const { data } = await query;
    setUsers((data as UserOption[]) || []);
    setLoading(false);
  };

  const toggleUser = (userId: string) => {
    if (selectedIds.includes(userId)) {
      onChange(selectedIds.filter(id => id !== userId));
    } else {
      onChange([...selectedIds, userId]);
    }
  };

  const selectedUsers = users.filter(u => selectedIds.includes(u.id));
  const unselectedUsers = users.filter(u => !selectedIds.includes(u.id));

  if (loading) return null;

  return (
    <div>
      <div style={{
        fontSize: compact ? '9px' : '10px', fontWeight: 700,
        color: 'var(--text-muted)', textTransform: 'uppercase',
        letterSpacing: '0.5px', marginBottom: '4px',
      }}>
        {label || (jobType === 'scanned_vehicle' ? 'Assign Installers' : 'Assign Team Members')}
      </div>

      {/* Selected users */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: selectedIds.length > 0 ? '6px' : '0' }}>
        {selectedUsers.map(u => (
          <span
            key={u.id}
            onClick={() => toggleUser(u.id)}
            style={{
              padding: '3px 8px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
              background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)',
              color: '#60a5fa', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px',
            }}
          >
            {u.full_name}
            <span style={{ fontSize: '9px', opacity: 0.7 }}>✕</span>
          </span>
        ))}
      </div>

      {/* Add button */}
      <button
        onClick={() => setShowPicker(!showPicker)}
        style={{
          padding: compact ? '6px 10px' : '8px 12px', borderRadius: '8px',
          fontSize: '11px', fontWeight: 700,
          background: 'var(--subtle-bg)', border: '1px solid var(--border)',
          color: 'var(--text-secondary)', cursor: 'pointer',
          width: compact ? 'auto' : '100%',
        }}
      >
        {showPicker ? '▲ Close' : `+ ${selectedIds.length > 0 ? 'Add More' : 'Assign'}`}
      </button>

      {/* Picker dropdown */}
      {showPicker && (
        <div style={{
          marginTop: '4px', borderRadius: '10px',
          background: 'var(--card)', border: '1px solid var(--border)',
          maxHeight: '200px', overflowY: 'auto',
        }}>
          {unselectedUsers.length === 0 ? (
            <div style={{ padding: '12px', textAlign: 'center', fontSize: '11px', color: 'var(--text-muted)' }}>
              {users.length === 0 ? 'No available users' : 'All users assigned'}
            </div>
          ) : (
            unselectedUsers.map(u => (
              <button
                key={u.id}
                onClick={() => { toggleUser(u.id); }}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  width: '100%', padding: '8px 12px',
                  background: 'transparent', border: 'none', borderBottom: '1px solid var(--border)',
                  color: 'var(--text-primary)', fontSize: '12px', fontWeight: 600,
                  cursor: 'pointer', textAlign: 'left',
                }}
              >
                <span>{u.full_name}</span>
                <span style={{
                  fontSize: '9px', fontWeight: 700,
                  color: ROLE_COLORS[u.role] || 'var(--text-muted)',
                  textTransform: 'uppercase',
                }}>
                  {u.role}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
