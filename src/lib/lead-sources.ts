/**
 * Shared intake vocabularies (audit Stage 1: lead source lived only in the
 * record page's Edit modal as a hardcoded array — the CREATE form never
 * asked, so the answer to "how did they find us" was lost at the moment it
 * was known; deal types were duplicated per page).
 *
 * One module so the create form, the edit modal, and the deals UI can't
 * drift. Values are stored as-is on prospects.lead_source /
 * prospect_opportunities.type (the latter DB-CHECK-constrained, migration
 * 053:23).
 */

export const LEAD_SOURCES = [
  'Cold Call',
  'Lead',
  'Maryland Heights Chamber of Commerce',
  'Little Black Book',
  'Other',
] as const;

export const OPP_TYPES: Record<string, string> = {
  tech_install: 'Tech Install',
  graphics: 'Graphics',
  rebrand: 'Rebrand',
  fleet_wrap: 'Fleet Wrap',
  other: 'Other',
};
