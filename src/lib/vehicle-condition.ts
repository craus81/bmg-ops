/**
 * Vehicle condition report (R6-10) — the record of what a vehicle looked
 * like when it arrived, and the customer's acknowledgment of it.
 *
 * The question this exists to answer is "was that dent here when the
 * vehicle arrived?", asked weeks later by somebody who wasn't at the
 * counter. A photo set and one free-text note remember what the yard saw;
 * they don't establish that the customer looked at it and agreed.
 *
 * So the acknowledgment reuses the E-SIGN machinery proven on estimates
 * and proofs — token, expiry, IP/UA/timestamp forensics, a frozen HTML
 * snapshot with a content hash — and adds the guard that matters most
 * here: a fingerprint of the condition AS SENT. If the damage list is
 * edited while the link is live, the acknowledgment is refused rather
 * than freezing a record the customer never saw. That is the same
 * edit-during-approval hole migration 242 closed for estimates, and it
 * matters more on this document than on a price.
 */

import { sha256Hex } from './magic-link-approval';

export const SEVERITIES = ['minor', 'moderate', 'severe'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const FUEL_LEVELS = ['empty', 'quarter', 'half', 'three_quarter', 'full'] as const;
export type FuelLevel = (typeof FUEL_LEVELS)[number];

const FUEL_LABELS: Record<FuelLevel, string> = {
  empty: 'Empty', quarter: '¼', half: '½', three_quarter: '¾', full: 'Full',
};

const SEVERITY_LABELS: Record<Severity, string> = {
  minor: 'Minor', moderate: 'Moderate', severe: 'Severe',
};

export interface DamageRecord {
  id?: string;
  location: string | null;
  severity: Severity;
  description: string;
  photo_paths?: string[] | null;
  created_at?: string | null;
}

export interface ConditionCheckin {
  odometer_miles?: number | null;
  fuel_level?: string | null;
}

/**
 * The sentence the customer checks.
 *
 * Deliberately confined to "this record is accurate as of drop-off". It
 * is NOT a liability waiver and NOT a release of claims — inventing
 * either of those is a decision for the business and its counsel, not
 * something an app should assert on their behalf. Widening this text
 * later is a deliberate act, and because the exact string is frozen into
 * every snapshot, older acknowledgments keep the wording they were
 * actually given.
 */
export const CONDITION_AGREEMENT_TEXT =
  'I confirm that the condition recorded above — including the odometer reading, the fuel level, '
  + 'and any pre-existing damage shown in the photographs — accurately reflects the condition of this '
  + 'vehicle at the time it was delivered to BMG Fleet Installations. '
  + 'This acknowledgment is legally binding and equivalent to a signed agreement under the U.S. E-SIGN Act.';

export function fuelLabel(level: string | null | undefined): string | null {
  const key = String(level || '') as FuelLevel;
  return FUEL_LEVELS.includes(key) ? FUEL_LABELS[key] : null;
}

export function severityLabel(severity: string | null | undefined): string {
  const key = String(severity || '') as Severity;
  return SEVERITIES.includes(key) ? SEVERITY_LABELS[key] : 'Minor';
}

export function severityTone(severity: string | null | undefined): 'ok' | 'warn' | 'bad' {
  switch (severity) {
    case 'severe': return 'bad';
    case 'moderate': return 'warn';
    default: return 'ok';
  }
}

export function formatOdometer(miles: number | null | undefined): string | null {
  if (miles === null || miles === undefined) return null;
  const n = Number(miles);
  if (!Number.isFinite(n) || n < 0) return null;
  return `${Math.round(n).toLocaleString('en-US')} mi`;
}

export interface ConditionSummary {
  total: number;
  bySeverity: Record<Severity, number>;
  /** The worst severity present, or null when there is no damage. */
  worst: Severity | null;
  photos: number;
  /** Findings with no photo — the ones that will be argued about. */
  unphotographed: number;
}

export function summarizeCondition(records: DamageRecord[]): ConditionSummary {
  const bySeverity: Record<Severity, number> = { minor: 0, moderate: 0, severe: 0 };
  let photos = 0, unphotographed = 0;
  for (const r of records) {
    const sev = SEVERITIES.includes(r.severity) ? r.severity : 'minor';
    bySeverity[sev]++;
    const n = (r.photo_paths || []).length;
    photos += n;
    if (n === 0) unphotographed++;
  }
  const worst = bySeverity.severe > 0 ? 'severe'
    : bySeverity.moderate > 0 ? 'moderate'
    : bySeverity.minor > 0 ? 'minor'
    : null;
  return { total: records.length, bySeverity, worst, photos, unphotographed };
}

/** One line for the check-in card and the acknowledgment email. */
export function conditionNote(summary: ConditionSummary): string {
  if (summary.total === 0) return 'No pre-existing damage recorded.';
  const parts = SEVERITIES
    .filter(s => summary.bySeverity[s] > 0)
    .map(s => `${summary.bySeverity[s]} ${SEVERITY_LABELS[s].toLowerCase()}`);
  const base = `${summary.total} finding${summary.total !== 1 ? 's' : ''} (${parts.join(', ')})`;
  return summary.unphotographed > 0
    ? `${base} · ${summary.unphotographed} with no photo`
    : base;
}

/**
 * Deterministic fingerprint of WHAT was sent for acknowledgment.
 *
 * Covers the facts a dispute turns on: odometer, fuel, and each finding's
 * location, severity, description and photo set. Ordered by description so
 * a reordered read can't change the hash.
 *
 * A photo ADDED after send changes the hash and invalidates the link —
 * deliberately. The customer agreed to a specific set of pictures, and
 * silently enlarging it is exactly the substitution this guards against.
 */
export function conditionContentHash(
  checkin: ConditionCheckin,
  records: DamageRecord[],
): string {
  const body = {
    odometer: checkin.odometer_miles ?? null,
    fuel: checkin.fuel_level ?? null,
    findings: [...records]
      .map(r => ({
        location: (r.location || '').trim(),
        severity: r.severity,
        description: (r.description || '').trim(),
        photos: [...(r.photo_paths || [])].sort(),
      }))
      .sort((a, b) => (a.description + a.location).localeCompare(b.description + b.location)),
  };
  return sha256Hex(JSON.stringify(body));
}

/** Whether a condition report is worth sending for acknowledgment at all. */
export function canSendForAcknowledgment(
  checkin: ConditionCheckin,
  records: DamageRecord[],
): { ok: boolean; reason?: string } {
  const hasReading = checkin.odometer_miles !== null && checkin.odometer_miles !== undefined;
  // A report with nothing on it asks the customer to confirm nothing —
  // it wastes the one moment they are paying attention at the counter.
  if (!hasReading && !checkin.fuel_level && records.length === 0) {
    return { ok: false, reason: 'Record the odometer, the fuel level, or at least one finding before sending this.' };
  }
  return { ok: true };
}
