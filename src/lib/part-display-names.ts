// One-time "fill in display names" pass for the parts catalog (owner ask
// 2026-10-22). Many parts carry only their part number as the display name
// (06N642 → "06N642") while the real words sit in Graphic Package or
// Description. The rule Craig OK'd:
//   1. Only a display name that is blank or just repeats the part number is
//      replaced — a name someone typed stays.
//   2. Graphic package wins when set, else the description.
//   3. A part with neither is left alone.
// The admin page (/admin/part-display-names) lists every proposal first and
// only writes on Run; real NetSuite parts are written to NetSuite too, since
// the parts sync copies NetSuite's displayname back over FleetSuite's.

export interface DisplayNamePart {
  id: string;
  netsuite_id: string | null;
  item_number: string | null;
  display_name: string | null;
  description: string | null;
  graphic_package: string | null;
}

export type DisplayNameSource = 'graphic_package' | 'description';

export interface DisplayNameProposal {
  id: string;
  netsuite_id: string | null;
  item_number: string;
  current: string;
  proposed: string;
  source: DisplayNameSource;
}

// Descriptions can be multi-line; a display name is one line.
const oneLine = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();

export function proposeDisplayName(p: DisplayNamePart): DisplayNameProposal | null {
  const itemNumber = oneLine(p.item_number);
  const current = oneLine(p.display_name);
  if (current && current.toLowerCase() !== itemNumber.toLowerCase()) return null;

  const pkg = oneLine(p.graphic_package);
  const desc = oneLine(p.description);
  const proposed = pkg || desc;
  const source: DisplayNameSource = pkg ? 'graphic_package' : 'description';
  if (!proposed || proposed.toLowerCase() === itemNumber.toLowerCase()) return null;

  return { id: p.id, netsuite_id: p.netsuite_id, item_number: itemNumber, current, proposed, source };
}

// Same test the part edit route uses: manual parts have no id, create-item
// mirrors a LOCAL-/bmg- stub. Only real ones are written to NetSuite.
export const isRealNetsuiteId = (id: string | null) => !!id && !/^(LOCAL-|bmg-)/i.test(id);
