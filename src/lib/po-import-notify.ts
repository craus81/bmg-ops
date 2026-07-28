/**
 * "Someone imported a PO" alerts for super admins.
 *
 * POs land in the Gmail review queue and a human confirms each one from the
 * POs page. Whoever owns graphics scheduling needs to know the moment a PO is
 * brought in — both to see what work is coming and to decide whether a
 * graphics job has to be opened — so every human-initiated import fans out to
 * the super admins, minus the person who did the importing.
 */

import { notifyMany, getSuperAdminIds } from '@/lib/notify';

export const PO_IMPORTED_NOTIFICATION_TYPE = 'po_imported';

/** Graphics lines are the part numbers starting 02 or RM (same rule graphics flagging uses). */
export function isGraphicsPartNumber(partNumber: string | null | undefined): boolean {
  return /^(02|RM)/i.test(String(partNumber || '').trim());
}

export function countGraphicsLines(lines: { part_number?: string | null }[]): number {
  return (lines || []).filter((l) => isGraphicsPartNumber(l?.part_number)).length;
}

export interface PoImportNotificationInput {
  poNumber: string;
  customer?: string | null;
  /** Display name of whoever confirmed the import. */
  actorName?: string | null;
  lineCount: number;
  graphicsCount: number;
  /** True when the import overwrote an existing PO instead of creating one. */
  updated?: boolean;
}

/**
 * Title + body for the alert. Pure so the wording is unit-testable.
 */
export function buildPoImportNotification(input: PoImportNotificationInput): { title: string; body: string } {
  const verb = input.updated ? 'updated' : 'imported';
  const who = input.actorName?.trim() || 'someone';
  const title = `PO #${input.poNumber} ${verb} by ${who}`;

  const parts: string[] = [];
  if (input.customer) parts.push(input.customer);
  parts.push(`${input.lineCount} line item${input.lineCount === 1 ? '' : 's'}`);
  parts.push(
    input.graphicsCount > 0
      ? `${input.graphicsCount} graphics part${input.graphicsCount === 1 ? '' : 's'} — graphics job may be needed`
      : 'no graphics parts',
  );

  return { title, body: parts.join(' · ') };
}

/** Resolve a user's display name for the alert, falling back to their email. */
async function actorDisplayName(supabase: any, actorId: string | null | undefined): Promise<string | null> {
  if (!actorId) return null;
  const { data } = await supabase
    .from('profiles')
    .select('full_name, email')
    .eq('id', actorId)
    .maybeSingle();
  return data?.full_name?.trim() || data?.email || null;
}

export interface NotifyPoImportedArgs extends Omit<PoImportNotificationInput, 'actorName'> {
  poId: string;
  /** Null for server-to-server calls (cron) — those don't alert anyone. */
  actorId: string | null;
}

/**
 * Fan the alert out to super admins. Never throws: a failed notification must
 * not fail the import that just succeeded.
 *
 * Returns the number of recipients (0 when there is no human actor, which is
 * how the cron's extract-only path stays silent).
 */
export async function notifyPoImported(supabase: any, args: NotifyPoImportedArgs): Promise<number> {
  if (!args.actorId) return 0;

  try {
    const [recipients, actorName] = await Promise.all([
      getSuperAdminIds(args.actorId),
      actorDisplayName(supabase, args.actorId),
    ]);
    if (recipients.length === 0) return 0;

    const { title, body } = buildPoImportNotification({ ...args, actorName });

    // Explicit channels: this is a targeted super-admin alert the user asked
    // for by name, so it does not go through the per-type preference gate
    // (whose PO toggle defaults to off). Push rides along so the in-app bell
    // also reaches phones.
    await notifyMany(recipients, {
      type: PO_IMPORTED_NOTIFICATION_TYPE,
      title,
      body,
      url: `/admin/pos?id=${args.poId}`,
      channels: ['in_app', 'email', 'push'],
      forceChannels: true,
    });
    return recipients.length;
  } catch (err) {
    console.warn('notifyPoImported failed:', err);
    return 0;
  }
}
