/**
 * sms_log writer (migration 350): one row per outbound customer text, the
 * texting counterpart of email_log. Best-effort — a failed log line must
 * never fail the send it describes.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { SendSmsResult } from './sms-provider';

type Db = SupabaseClient<any, any, any>;

export interface SmsLogMeta {
  kind: string;
  sentBy?: string | null;
  /** Deep link to the record the text is about; the history reads by it. */
  contextUrl?: string | null;
}

/** The sms_log status for a send result: skipped = texting turned off. */
export function smsLogStatus(result: Pick<SendSmsResult, 'ok' | 'skipped'> | null): 'sent' | 'failed' | 'skipped' {
  if (result?.skipped) return 'skipped';
  return result?.ok ? 'sent' : 'failed';
}

export async function logSms(
  service: Db,
  to: string,
  body: string,
  result: SendSmsResult | null,
  meta: SmsLogMeta,
  error?: string | null,
): Promise<void> {
  try {
    const { error: insErr } = await service.from('sms_log').insert({
      kind: meta.kind,
      to_phone: to,
      body,
      provider_name: result?.providerName || null,
      provider_sid: result?.sid || null,
      status: smsLogStatus(result),
      error: error || result?.error || null,
      sent_by: meta.sentBy || null,
      context_url: meta.contextUrl || null,
    });
    if (insErr) console.error('sms_log insert failed:', insErr.message);
  } catch (err) {
    console.error('sms_log insert failed:', err);
  }
}
