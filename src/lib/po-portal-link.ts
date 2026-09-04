/**
 * Issuing the customer PO-status portal link (migration 260) — shared by
 * the customer-record action and the "send the link" email flag, so a
 * link is minted exactly one way.
 */

import crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { deepLinks } from './deep-links';

export function portalLinkUrl(token: string): string {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app').replace(/\/$/, '');
  return `${appUrl}${deepLinks.customerPoPortal(token)}`;
}

/**
 * Return the customer's current portal token, minting one when none exists
 * (or always, with `regenerate`). Never reuses an old token after a
 * regenerate: the previous link must stop working.
 */
export async function ensurePortalLink(
  service: SupabaseClient,
  customer: { id: string; portal_token?: string | null; portal_token_created_at?: string | null },
  opts: { regenerate?: boolean } = {},
): Promise<{ token: string; createdAt: string; changed: boolean }> {
  if (customer.portal_token && !opts.regenerate) {
    return { token: customer.portal_token, createdAt: customer.portal_token_created_at || new Date().toISOString(), changed: false };
  }
  const token = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const { error } = await service
    .from('customers')
    .update({ portal_token: token, portal_token_created_at: createdAt })
    .eq('id', customer.id);
  if (error) throw new Error(`Could not save the portal link: ${error.message}`);
  return { token, createdAt, changed: true };
}
