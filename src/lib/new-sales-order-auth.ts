import { NextResponse } from 'next/server';
import { profileHasFeature } from '@/lib/api-auth';
import { NEW_SALES_ORDER_FEATURES } from '@/lib/new-sales-order';

/**
 * Server only: after requireAuth, the 403 for anyone without the Estimates or the Invoicing permission
 * (Craig 2026-10-31, 1A; 2026-11-05 admins and sales), or null when they may make sales orders.
 */
export async function salesOrderMakerError(auth: { user: { id: string }; profile?: any }): Promise<NextResponse | null> {
  for (const key of NEW_SALES_ORDER_FEATURES) {
    if (await profileHasFeature(auth.user.id, auth.profile, key)) return null;
  }
  return NextResponse.json({ error: 'You need the Estimates or Invoicing permission to make sales orders.' }, { status: 403 });
}
