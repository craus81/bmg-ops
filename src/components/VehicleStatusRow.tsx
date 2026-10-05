'use client';

import {
  VEHICLE_ROW,
  VEHICLE_ROW_LABELS,
  VEHICLE_ROW_COLORS,
  vehicleRowKey,
  vehicleDoneChecks,
  type VehicleRowKey,
} from '@/lib/types';

interface RowVehicle {
  status?: string | null;
  shop_stage?: string | null;
  graphics_install_status?: string | null;
  upfit_completed_at?: string | null;
  matched_graphics_job_id?: string | null;
  graphics_signal?: string | null;
}

/**
 * The one-line Update Status row (owner layout 2026-10-02): Received,
 * Graphics In Progress, Graphics Complete, Upfit In Progress, Upfit Complete, Complete,
 * Shipped — no forced order. The current button gets the ● dot; Graphics
 * Complete and Upfit Complete keep a green ✓ once done, whatever is current.
 * Graphics buttons show when the vehicle has a graphics job, its sales order
 * or estimate has graphics lines (graphics_signal — vinyl, Graphics Install
 * Labor, …; owner ask 2026-10-05), or the lane was already worked.
 */
export default function VehicleStatusRow({
  vehicle,
  disabled,
  onPick,
}: {
  vehicle: RowVehicle;
  disabled?: boolean;
  onPick: (key: VehicleRowKey) => void;
}) {
  const current = vehicleRowKey(vehicle);
  const done = vehicleDoneChecks(vehicle);
  const lane = vehicle.graphics_install_status || 'pending';
  const showGraphics = !!vehicle.matched_graphics_job_id || !!vehicle.graphics_signal || lane === 'in_progress' || lane === 'complete';
  const keys = VEHICLE_ROW.filter(k => showGraphics || (k !== 'graphics' && k !== 'graphics_complete'));

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
      {keys.map(k => {
        const colors = VEHICLE_ROW_COLORS[k];
        const isCurrent = k === current;
        const isDone = (k === 'graphics_complete' && done.graphics) || (k === 'upfit_complete' && done.upfit);
        const lit = isCurrent || isDone;
        const label = VEHICLE_ROW_LABELS[k];
        return (
          <button
            key={k}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              if (!isCurrent && !disabled) onPick(k);
            }}
            disabled={isCurrent || disabled}
            title={isDone && !isCurrent ? `${label} — done` : undefined}
            style={{
              padding: '8px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
              background: lit ? colors.bg : 'var(--subtle-bg)',
              border: `1.5px solid ${lit ? colors.border : 'var(--border)'}`,
              color: lit ? colors.text : 'var(--text-secondary)',
              opacity: !isCurrent && disabled ? 0.4 : 1,
              cursor: isCurrent || disabled ? 'default' : 'pointer',
              transition: 'all 0.15s',
            }}
          >
            {isDone ? `✓ ${label}` : isCurrent ? `● ${label}` : label}
          </button>
        );
      })}
    </div>
  );
}
