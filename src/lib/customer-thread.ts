import type { SupabaseClient } from '@supabase/supabase-js';

interface VehicleLike {
  id: string;
  vin: string;
  customer_name: string | null;
}

export type ThreadResult =
  | { ok: true; threadId: string }
  | { ok: false; error: string };

/**
 * Resolve the customer + primary contact for a fleet check-in vehicle,
 * creating a placeholder primary contact if none exists, then open or
 * fetch the customer thread keyed by `fleet_checkin / vehicle.id`.
 *
 * Caller is responsible for alerting / navigating with the returned
 * threadId. Designed to be used from both the pick-list page and the
 * /tracking expanded panel without duplicating the resolution logic.
 */
export async function openOrCreateVehicleThread(
  supabase: SupabaseClient,
  vehicle: VehicleLike,
  userId: string | undefined,
): Promise<ThreadResult> {
  let customerId: string | null = null;
  let contactId: string | null = null;

  if (vehicle.customer_name) {
    const { data: cust } = await supabase
      .from('customers')
      .select('id, email, phone')
      .ilike('company_name', vehicle.customer_name)
      .maybeSingle();
    if (cust) {
      customerId = cust.id;
      const { data: primary } = await supabase
        .from('external_contacts')
        .select('id')
        .eq('customer_id', cust.id)
        .eq('is_primary', true)
        .maybeSingle();
      if (primary) {
        contactId = primary.id;
      } else {
        const { data: created } = await supabase
          .from('external_contacts')
          .insert({
            customer_id: cust.id,
            name: vehicle.customer_name,
            email: cust.email || null,
            phone: cust.phone || null,
            is_primary: true,
            created_by: userId,
          })
          .select('id')
          .single();
        contactId = created?.id || null;
      }
    }
  }

  if (!contactId) {
    return { ok: false, error: 'No contact available for this customer. Add a contact in the inbox first.' };
  }

  try {
    const res = await fetch('/api/customer-threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contactId,
        customerId,
        contextEntityType: 'fleet_checkin',
        contextEntityId: vehicle.id,
        subject: `${vehicle.vin} install`,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.thread?.id) {
      return { ok: false, error: data.error || `Failed (${res.status})` };
    }
    return { ok: true, threadId: data.thread.id };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Network error' };
  }
}
