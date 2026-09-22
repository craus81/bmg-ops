/**
 * Recording an approval-page open, and raising the alerts that ride on it
 * (R6-9). Called from the public approval GETs, which already run
 * server-side on every open — no tracking pixel, no client cooperation.
 *
 * NOTHING here may throw or slow the customer down. A customer opening a
 * quote must see the quote; an analytics problem is not their problem, and a
 * failed notify must never become a blank page in front of a buyer.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { NextRequest } from 'next/server';
import { getRequestIp, getRequestUserAgent } from './magic-link-approval';
import { classifyViewer, summarizeViews, isReopen, DEDUPE_MINUTES, type QuoteViewRow } from './quote-views';
import { notifyMany } from './notify';
import { deepLinks } from './deep-links';

export interface RecordViewArgs {
  type: 'estimate' | 'wrap';
  id: string;
  req: NextRequest | Request;
  /** When the quote was sent — the scanner window is measured from it. */
  sentAt?: string | null;
  /** Who to tell. Empty = record the view, tell nobody. */
  repIds: (string | null | undefined)[];
  /** How the quote reads in a notification: "Estimate #1042 — 6 vans". */
  label: string;
  customerName?: string | null;
}

export async function recordQuoteView(
  service: SupabaseClient,
  args: RecordViewArgs,
): Promise<void> {
  try {
    const ip = getRequestIp(args.req);
    const userAgent = getRequestUserAgent(args.req);
    const nowIso = new Date().toISOString();

    // History first: it decides both the dedupe and whether this open is a
    // first look or a return. Bounded — a quote with more opens than this has
    // already told us everything the alerts need.
    const { data: priorRows } = await service
      .from('quote_views')
      .select('viewed_at, viewer_kind, ip_address, user_agent')
      .eq('quote_type', args.type)
      .eq('quote_id', args.id)
      .order('viewed_at', { ascending: false })
      .limit(200);
    const prior = (priorRows || []) as QuoteViewRow[];

    // A customer refreshing, or clicking through twice, is ONE view. Keyed on
    // address AND user agent rather than address alone: a whole office shares
    // one NAT address, and dropping a second person's first look because a
    // colleague opened it twenty minutes earlier would undercount the exact
    // thing this measures.
    const cutoff = Date.now() - DEDUPE_MINUTES * 60_000;
    const uaKey = String(userAgent || '').slice(0, 500);
    const duplicate = prior.some(v =>
      v.ip_address === ip
      && String(v.user_agent || '') === uaKey
      && Date.parse(v.viewed_at) >= cutoff);
    if (duplicate) return;

    const secondsSinceSent = args.sentAt
      ? Math.floor((Date.now() - Date.parse(args.sentAt)) / 1000)
      : null;
    const { kind, signal } = classifyViewer(userAgent, {
      secondsSinceSent: Number.isNaN(secondsSinceSent as number) ? null : secondsSinceSent,
    });

    const before = summarizeViews(prior);
    const reopen = kind === 'human' && isReopen(before.lastHumanAt, nowIso);
    const firstLook = kind === 'human' && before.humanCount === 0;
    const alerting = firstLook || reopen;

    const { error } = await service.from('quote_views').insert({
      quote_type: args.type,
      quote_id: args.id,
      viewed_at: nowIso,
      ip_address: ip,
      user_agent: uaKey || null,
      viewer_kind: kind,
      view_signal: signal,
      notified_at: alerting ? nowIso : null,
    });
    // Migration 302 not applied yet, or the insert failed: the customer's
    // page is unaffected and there is nothing to alert about.
    if (error) return;
    if (!alerting) return;

    const targets = [...new Set(args.repIds.filter(Boolean))] as string[];
    if (targets.length === 0) return;

    const url = args.type === 'estimate'
      ? deepLinks.quoteFollowUps('estimate', args.id)
      : deepLinks.quoteFollowUps('wrap', args.id);
    const who = args.customerName || 'The customer';

    await notifyMany(targets, {
      type: 'quote_followup',
      title: firstLook
        ? `👀 Opened — ${args.label}`
        : `👀 Opened again — ${args.label}`,
      body: firstLook
        ? `${who} just opened ${args.label} for the first time.`
        : `${who} came back to ${args.label} after ${daysBetween(before.lastHumanAt, nowIso)} quiet days. Worth a call while it is in front of them.`,
      url,
      channels: ['in_app', 'push'],
    });
  } catch {
    // Swallowed on purpose — see the file header. A view that goes
    // unrecorded costs a chip; an exception here costs a customer their page.
  }
}

function daysBetween(a: string | null, b: string): number {
  if (!a) return 0;
  return Math.max(0, Math.floor((Date.parse(b) - Date.parse(a)) / 86_400_000));
}
