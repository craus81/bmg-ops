/**
 * Graphics job approval history (owner ask 2026-10-07): every proof round
 * with the emails, texts and customer replies that belong to it, so the
 * job's Customer Approval card can expand into the whole conversation.
 *
 * The sources already exist separately — graphics_proof_rounds (one row per
 * proof sent), email_log and sms_log (read by the job's context_url) and
 * the job's customer_threads messages (customer text/email replies, and
 * messages staff typed in that thread). This file is the pure part: it
 * folds those rows into rounds, newest round first. The API route
 * (/api/graphics-jobs/[id]/approval-history) does the reads.
 */

import { roundLabel, type RoundOutcome } from './proof-rounds';

export type MessageStatus =
  | 'sent' | 'delivered' | 'delivery_delayed' | 'bounced' | 'complained'
  | 'failed' | 'skipped' | 'pending' | 'received';

export interface HistoryMessage {
  id: string;
  /** 'email_log' rows open in the sent-email viewer; the rest show inline. */
  source: 'email_log' | 'sms_log' | 'thread';
  channel: 'email' | 'text';
  direction: 'out' | 'in';
  at: string;
  /** email_log/sms_log kind — 'proof_approval', 'pickup_notice', … */
  kind: string | null;
  /** Email subject, or null. */
  subject: string | null;
  /** Text body / thread message body, or null for logged emails. */
  body: string | null;
  /** Recipients for outbound, sender for inbound. */
  who: string;
  sentByName: string | null;
  status: MessageStatus | null;
  detail: string | null;
  /** Automatic proof reminder (or the customer's own relink request). */
  reminder: boolean;
}

export interface HistoryRound {
  roundNumber: number;
  label: string;
  addressing: string | null;
  proofFileId: string | null;
  proofFileName: string | null;
  sentAt: string | null;
  sentByName: string | null;
  outcome: RoundOutcome;
  decidedAt: string | null;
  rejectionReason: string | null;
  messages: HistoryMessage[];
}

export interface ApprovalHistory {
  rounds: HistoryRound[];
  /** Messages that belong to no round: pickup notices, and anything sent
   *  before rounds were recorded. */
  other: HistoryMessage[];
  /** How the final decision was made (latest decision only — the job
   *  columns keep one). */
  decision: {
    via: string | null;
    target: string | null;
    timeOnPageSeconds: number | null;
    signedDocument: boolean;
  } | null;
}

export interface RoundRow {
  round_number: number;
  addressing: string | null;
  proof_file_id: string | null;
  sent_at: string | null;
  sent_by: string | null;
  outcome: RoundOutcome;
  decided_at: string | null;
  rejection_reason: string | null;
  created_at?: string | null;
}

/** Kinds that file under a round. Everything else (pickup notices) goes to
 *  "other". Thread messages have no kind and file by time. */
const PROOF_KINDS = new Set(['proof_approval']);

/** A thread message within this long of a logged email/text on the same
 *  channel is the same send (the pickup notice writes both). */
const SAME_SEND_MS = 2 * 60 * 1000;

/** The round a send rounds up to may be stamped a moment AFTER the email
 *  log row on a skewed clock; allow this much slack. */
const ROUND_SLACK_MS = 60 * 1000;

const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);

/** Drop thread copies of sends already in email_log / sms_log. */
export function dropDuplicateThreadCopies(logged: HistoryMessage[], thread: HistoryMessage[]): HistoryMessage[] {
  return thread.filter(t => {
    if (t.direction !== 'out') return true;
    const at = ms(t.at);
    return !logged.some(l => l.channel === t.channel && Math.abs(ms(l.at) - at) <= SAME_SEND_MS);
  });
}

export function buildApprovalHistory(
  rounds: RoundRow[],
  messages: HistoryMessage[],
  names: Record<string, string>,
  fileNames: Record<string, string>,
  decision: ApprovalHistory['decision'],
): ApprovalHistory {
  const ordered = [...rounds].sort((a, b) => a.round_number - b.round_number);
  const out: HistoryRound[] = ordered.map(r => ({
    roundNumber: r.round_number,
    label: roundLabel(r.round_number),
    addressing: r.addressing || null,
    proofFileId: r.proof_file_id || null,
    proofFileName: r.proof_file_id ? fileNames[r.proof_file_id] || null : null,
    sentAt: r.sent_at || r.created_at || null,
    sentByName: r.sent_by ? names[r.sent_by] || null : null,
    outcome: r.outcome,
    decidedAt: r.decided_at || null,
    rejectionReason: r.rejection_reason || null,
    messages: [],
  }));

  const other: HistoryMessage[] = [];
  const sorted = [...messages].sort((a, b) => ms(a.at) - ms(b.at));
  for (const m of sorted) {
    const filesUnderRound = m.kind === null || PROOF_KINDS.has(m.kind);
    if (!filesUnderRound) { other.push(m); continue; }
    // The latest round already open when this message went.
    const at = ms(m.at);
    let home: HistoryRound | null = null;
    for (const r of out) {
      if (ms(r.sentAt) <= at + ROUND_SLACK_MS) home = r;
    }
    if (home) home.messages.push(m);
    else other.push(m);
  }

  return { rounds: out.reverse(), other, decision };
}

/** "Revision 2 · 1 change request · 6 messages" — the collapsed line. */
export function historySummary(h: ApprovalHistory): string {
  const parts: string[] = [];
  const latest = h.rounds[0];
  if (latest) parts.push(latest.label);
  const changes = h.rounds.filter(r => r.outcome === 'rejected').length;
  if (changes > 0) parts.push(`${changes} change request${changes !== 1 ? 's' : ''}`);
  const msgs = h.rounds.reduce((n, r) => n + r.messages.length, 0) + h.other.length;
  if (msgs > 0) parts.push(`${msgs} message${msgs !== 1 ? 's' : ''}`);
  return parts.join(' · ');
}
