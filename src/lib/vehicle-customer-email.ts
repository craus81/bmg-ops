/**
 * The three customer-facing vehicle emails, as pure content.
 *
 * All three used to fire on their own — "ready" and "shipped" the moment
 * staff moved a vehicle's status, the pickup reminder weekly from the
 * pickup-nudges cron. The owner's call on 2026-09-14 was that no customer
 * email leaves FleetSuite without a person choosing to send it, so the
 * crons and the status route now PROMPT a human and this builds what that
 * human previews and sends (`/api/vehicle-tracking/notify-customer`).
 *
 * Pure on purpose: the compose screen's preview and the real send call the
 * same function with the same vehicle, so what the sender approves is what
 * the customer gets. The greeting, the CTA and the SMS all live here — one
 * place per kind, no second copy to drift.
 */

export type VehicleEmailKind = 'ready' | 'shipped' | 'pickup_reminder';

export const VEHICLE_EMAIL_KINDS: VehicleEmailKind[] = ['ready', 'shipped', 'pickup_reminder'];

export const VEHICLE_EMAIL_LABEL: Record<VehicleEmailKind, string> = {
  ready: 'Ready for pickup',
  shipped: 'Shipped',
  pickup_reminder: 'Pickup reminder',
};

export interface VehicleEmailVehicle {
  id: string;
  vin?: string | null;
  vehicle_year?: string | number | null;
  vehicle_make?: string | null;
  vehicle_model?: string | null;
  customer_portal_token?: string | null;
  /** Whole days the vehicle has been complete — only the reminder uses it. */
  daysReady?: number | null;
}

export interface VehicleEmailContent {
  /** Email subject line. */
  subject: string;
  /** Heading inside the email card. */
  title: string;
  /** Body paragraph. */
  body: string;
  ctaUrl: string;
  ctaLabel: string;
  /** Threaded into customer_threads/customer_messages. */
  threadSubject: string;
  /** Sent only when a phone is on file and the kind warrants it. */
  smsBody: string | null;
}

/** "2024 Ford Transit", or the VIN tail when we have no description. */
export function vehicleEmailLabel(v: VehicleEmailVehicle): string {
  const name = [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ');
  return name || `VIN ${String(v.vin || '').slice(-8)}` || 'your vehicle';
}

/**
 * Where the customer lands. A vehicle's own booking token opens the pick-a-
 * slot page; without one (legacy rows that predate migration 001) we fall
 * back to the portal dashboard rather than a dead link.
 */
function vehicleCta(v: VehicleEmailVehicle, appUrl: string): { url: string; label: string; booking: boolean } {
  return v.customer_portal_token
    ? { url: `${appUrl}/book/${v.customer_portal_token}`, label: 'Book your pickup time', booking: true }
    : { url: `${appUrl}/customer/dashboard`, label: 'View order status', booking: false };
}

export function buildVehicleCustomerEmail(
  v: VehicleEmailVehicle,
  kind: VehicleEmailKind,
  appUrl: string,
): VehicleEmailContent {
  const label = vehicleEmailLabel(v);
  const vinTail = v.vin ? ` (VIN ending ${String(v.vin).slice(-8)})` : '';
  const cta = vehicleCta(v, appUrl);

  if (kind === 'shipped') {
    const body = `Your ${label}${vinTail} has left our facility. Reply to this email with any questions.`;
    return {
      subject: `[BMG Fleet] Your vehicle has shipped — ${label}`,
      title: `On its way — ${label}`,
      body,
      // A shipped vehicle has nothing left to book; the dashboard is the
      // only honest destination even when a booking token exists.
      ctaUrl: `${appUrl}/customer/dashboard`,
      ctaLabel: 'View order status',
      threadSubject: `${label} shipped`,
      smsBody: null,
    };
  }

  if (kind === 'pickup_reminder') {
    const days = v.daysReady ?? null;
    const waited = days && days > 0
      ? ` has been ready for pickup for ${days} day${days === 1 ? '' : 's'}`
      : ' is ready for pickup';
    const body = cta.booking
      ? `Your ${label}${waited}. Book a time that works and we'll have it waiting.`
      : `Your ${label}${waited}. Please contact us to arrange pickup.`;
    return {
      subject: `[BMG Fleet] Reminder — your ${label} is ready for pickup`,
      title: `Your ${label} is ready`,
      body,
      ctaUrl: cta.url,
      ctaLabel: cta.label,
      threadSubject: `${label} ready for pickup`,
      smsBody: cta.booking
        ? `[BMG Fleet] Reminder: your ${label} is ready for pickup. Book a time: ${cta.url}`
        : null,
    };
  }

  const body = cta.booking
    ? `The install for your ${label}${vinTail} is complete. Book a pickup time online — or reply to this email if another arrangement works better.`
    : `The install for your ${label}${vinTail} is complete. Please contact us to arrange pickup.`;
  return {
    subject: `[BMG Fleet] Your vehicle is ready — ${label}`,
    title: `Your vehicle is ready — ${label}`,
    body,
    ctaUrl: cta.url,
    ctaLabel: cta.label,
    threadSubject: `${label} ready for pickup`,
    smsBody: cta.booking
      ? `[BMG Fleet] Your ${label} is ready for pickup. Book a time: ${cta.url}`
      : null,
  };
}
