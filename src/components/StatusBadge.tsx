'use client';

import type { VehicleTrackingStatus } from '@/lib/types';
import { VEHICLE_STATUS_LABELS, VEHICLE_STATUS_COLORS } from '@/lib/types';

interface StatusBadgeProps {
  status: VehicleTrackingStatus;
  size?: 'sm' | 'md';
}

export default function StatusBadge({ status, size = 'sm' }: StatusBadgeProps) {
  const colors = VEHICLE_STATUS_COLORS[status];
  const label = VEHICLE_STATUS_LABELS[status];
  const isStuck = status === 'stuck_parts' || status === 'stuck_graphics';

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      padding: size === 'sm' ? '3px 8px' : '5px 12px',
      borderRadius: '8px',
      background: colors.bg,
      border: `1px solid ${colors.border}`,
      color: colors.text,
      fontSize: size === 'sm' ? '11px' : '13px',
      fontWeight: 700,
      whiteSpace: 'nowrap',
      ...(isStuck ? { animation: 'pulse-badge 2s ease-in-out infinite' } : {}),
    }}>
      {isStuck && <span style={{ fontSize: size === 'sm' ? '9px' : '11px' }}>⚠</span>}
      {label}
    </span>
  );
}
