'use client';

import type { VehicleTrackingStatus, GraphicsInstallStatus } from '@/lib/types';
import {
  VEHICLE_STATUS_LABELS,
  VEHICLE_STATUS_COLORS,
  GRAPHICS_INSTALL_LABELS,
  GRAPHICS_INSTALL_COLORS,
} from '@/lib/types';

interface StatusBadgeProps {
  status: string;
  size?: 'sm' | 'md';
}

const FALLBACK_COLORS = {
  bg: 'rgba(148,163,184,0.10)',
  border: 'rgba(148,163,184,0.40)',
  text: '#94a3b8',
};

// Graphics-lane history rows arrive prefixed (e.g. `graphics:in_progress`)
// from /api/vehicle-tracking/graphics-install-status. Decode them back to the
// install-lane label/color set instead of crashing on a missing vehicle-status
// key.
function resolveStatus(status: string) {
  if (status.startsWith('graphics:')) {
    const lane = status.slice('graphics:'.length) as GraphicsInstallStatus;
    const colors = GRAPHICS_INSTALL_COLORS[lane];
    const label = GRAPHICS_INSTALL_LABELS[lane];
    if (colors && label) {
      return { colors, label: `Graphics: ${label}`, isStuck: lane === 'stuck' };
    }
    return { colors: FALLBACK_COLORS, label: status, isStuck: false };
  }
  const vehicleStatus = status as VehicleTrackingStatus;
  const colors = VEHICLE_STATUS_COLORS[vehicleStatus];
  const label = VEHICLE_STATUS_LABELS[vehicleStatus];
  if (colors && label) {
    return {
      colors,
      label,
      isStuck: vehicleStatus === 'stuck_parts' || vehicleStatus === 'stuck_graphics',
    };
  }
  return { colors: FALLBACK_COLORS, label: status, isStuck: false };
}

export default function StatusBadge({ status, size = 'sm' }: StatusBadgeProps) {
  const { colors, label, isStuck } = resolveStatus(status);

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
