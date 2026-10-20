/**
 * Delivery method — how a job's graphics reach the customer (migration 414).
 *
 * Valarie's ask (2026-10-20): a required choice on Graphics Production jobs,
 * each method with its own details. Craig chose to enter it on the estimate
 * and carry it to the upfit project and the project's graphics jobs, kept in
 * step both ways (POST /api/delivery). The same `Delivery` value lives on
 * three tables; graphics_jobs keeps its older ship_speed / ship_to columns
 * for the speed and address, the other two have delivery_* columns.
 */
import { SHOP_INSTALL_LOCATION } from '@/lib/shop-inbound';

export type DeliveryMethod = 'direct_ship' | 'onsite_install' | 'customer_pickup' | 'bmg_shop';
export type DeliveryInstaller = 'bmg_crew' | 'cni';
export type DeliveryTable = 'graphics_jobs' | 'estimates' | 'upfit_projects';

export interface Delivery {
  method: DeliveryMethod | null;
  shipSpeed: string | null;
  address: string | null;
  contactName: string | null;
  contactPhone: string | null;
  notes: string | null;
  installer: DeliveryInstaller | null;
}

export const EMPTY_DELIVERY: Delivery = {
  method: null, shipSpeed: null, address: null, contactName: null, contactPhone: null, notes: null, installer: null,
};

export const DELIVERY_METHOD_OPTIONS: { value: DeliveryMethod; label: string; hint: string }[] = [
  { value: 'direct_ship', label: 'Direct Ship', hint: 'UPS to the customer' },
  { value: 'onsite_install', label: 'Onsite Installation', hint: 'We install at their site' },
  { value: 'customer_pickup', label: 'Customer Pick-Up', hint: 'They collect it here' },
  { value: 'bmg_shop', label: 'Installed at BMG Shop', hint: "Vehicle comes to O'Fallon" },
];

/** UPS services a Direct Ship job can use (the older pickup / installed
 *  values in GRAPHICS_SHIP_SPEED_OPTIONS are now delivery methods). */
export const DELIVERY_SHIP_SPEED_OPTIONS: { value: string; label: string }[] = [
  { value: 'ups_ground', label: 'UPS Ground' },
  { value: 'ups_3_day_select', label: 'UPS 3 Day Select' },
  { value: 'ups_2nd_day_air', label: 'UPS 2nd Day Air' },
  { value: 'ups_next_day_air', label: 'UPS Next Day Air' },
];

export const DELIVERY_INSTALLER_OPTIONS: { value: DeliveryInstaller; label: string }[] = [
  { value: 'bmg_crew', label: 'BMG crew' },
  { value: 'cni', label: 'CNI installer' },
];

export function deliveryMethodLabel(method: string | null | undefined): string | null {
  if (!method) return null;
  return DELIVERY_METHOD_OPTIONS.find(o => o.value === method)?.label ?? method;
}

export function deliveryShipSpeedLabel(speed: string | null | undefined): string | null {
  if (!speed) return null;
  return DELIVERY_SHIP_SPEED_OPTIONS.find(o => o.value === speed)?.label ?? null;
}

export function deliveryInstallerLabel(installer: string | null | undefined): string | null {
  if (!installer) return null;
  return DELIVERY_INSTALLER_OPTIONS.find(o => o.value === installer)?.label ?? null;
}

const METHODS = new Set<string>(DELIVERY_METHOD_OPTIONS.map(o => o.value));
const INSTALLERS = new Set<string>(DELIVERY_INSTALLER_OPTIONS.map(o => o.value));

const clean = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
};

/** Column names for each table. graphics_jobs reuses ship_speed / ship_to. */
const COLUMNS: Record<DeliveryTable, Record<keyof Delivery, string>> = {
  graphics_jobs: {
    method: 'delivery_method', shipSpeed: 'ship_speed', address: 'ship_to',
    contactName: 'delivery_contact_name', contactPhone: 'delivery_contact_phone',
    notes: 'delivery_notes', installer: 'delivery_installer',
  },
  estimates: {
    method: 'delivery_method', shipSpeed: 'delivery_ship_speed', address: 'delivery_address',
    contactName: 'delivery_contact_name', contactPhone: 'delivery_contact_phone',
    notes: 'delivery_notes', installer: 'delivery_installer',
  },
  upfit_projects: {
    method: 'delivery_method', shipSpeed: 'delivery_ship_speed', address: 'delivery_address',
    contactName: 'delivery_contact_name', contactPhone: 'delivery_contact_phone',
    notes: 'delivery_notes', installer: 'delivery_installer',
  },
};

/** Comma list for a .select() of one table's delivery columns. */
export function deliveryColumns(table: DeliveryTable): string {
  return Object.values(COLUMNS[table]).join(', ');
}

/** Normalize: trims text, drops unknown values, and clears the fields the
 *  chosen method does not use (a speed on a pickup, an installer on a ship). */
export function normalizeDelivery(d: Partial<Delivery> | null | undefined): Delivery {
  const method = d?.method && METHODS.has(d.method) ? d.method : null;
  const out: Delivery = {
    method,
    shipSpeed: clean(d?.shipSpeed),
    address: clean(d?.address),
    contactName: clean(d?.contactName),
    contactPhone: clean(d?.contactPhone),
    notes: clean(d?.notes),
    installer: d?.installer && INSTALLERS.has(d.installer) ? d.installer : null,
  };
  if (method !== 'direct_ship') out.shipSpeed = null;
  else if (out.shipSpeed && !DELIVERY_SHIP_SPEED_OPTIONS.some(o => o.value === out.shipSpeed)) out.shipSpeed = null;
  if (method !== 'onsite_install') out.installer = null;
  if (method === 'customer_pickup' || method === 'bmg_shop') out.address = null;
  return out;
}

export function deliveryFromRow(row: Record<string, any> | null | undefined, table: DeliveryTable): Delivery {
  if (!row) return { ...EMPTY_DELIVERY };
  const c = COLUMNS[table];
  return {
    method: (METHODS.has(row[c.method]) ? row[c.method] : null) as DeliveryMethod | null,
    shipSpeed: row[c.shipSpeed] ?? null,
    address: row[c.address] ?? null,
    contactName: row[c.contactName] ?? null,
    contactPhone: row[c.contactPhone] ?? null,
    notes: row[c.notes] ?? null,
    installer: (INSTALLERS.has(row[c.installer]) ? row[c.installer] : null) as DeliveryInstaller | null,
  };
}

/** Row-shaped copy without normalizing, for form state that holds row
 *  columns (switching methods back and forth keeps what was typed). */
export function deliveryRowRaw(d: Delivery, table: DeliveryTable): Record<string, string | null> {
  const c = COLUMNS[table];
  return {
    [c.method]: d.method, [c.shipSpeed]: d.shipSpeed, [c.address]: d.address,
    [c.contactName]: d.contactName, [c.contactPhone]: d.contactPhone,
    [c.notes]: d.notes, [c.installer]: d.installer,
  };
}

/** Row values to write, normalized. On a graphics job with no method set
 *  the legacy ship_speed is left alone so an old job keeps its history. */
export function deliveryToRow(d: Partial<Delivery> | null | undefined, table: DeliveryTable): Record<string, string | null> {
  const n = normalizeDelivery(d);
  const c = COLUMNS[table];
  const row: Record<string, string | null> = {
    [c.method]: n.method,
    [c.shipSpeed]: n.shipSpeed,
    [c.address]: n.address,
    [c.contactName]: n.contactName,
    [c.contactPhone]: n.contactPhone,
    [c.notes]: n.notes,
    [c.installer]: n.installer,
  };
  if (table === 'graphics_jobs' && !n.method) {
    delete row[c.shipSpeed];
    delete row[c.address];
  }
  return row;
}

/** What's still missing for the chosen method, as a sentence to show the
 *  person (null when complete). `required` = no method is itself missing. */
export function deliveryProblem(d: Partial<Delivery> | null | undefined, required: boolean): string | null {
  const n = normalizeDelivery(d);
  if (!n.method) {
    return required
      ? 'Pick a delivery method: Direct Ship, Onsite Installation, Customer Pick-Up or Installed at BMG Shop.'
      : null;
  }
  const need: string[] = [];
  if (n.method === 'direct_ship') {
    if (!n.shipSpeed) need.push('a shipping speed');
    if (!n.address) need.push('a ship-to address');
  } else if (n.method === 'onsite_install') {
    if (!n.address) need.push('the install address');
    if (!n.contactName) need.push('the installation contact');
    if (!n.contactPhone) need.push("the contact's phone");
  } else if (n.method === 'customer_pickup') {
    if (!n.contactName) need.push('who to contact');
    if (!n.contactPhone) need.push('their phone or email');
  }
  if (need.length === 0) return null;
  const list = need.length === 1 ? need[0] : `${need.slice(0, -1).join(', ')} and ${need[need.length - 1]}`;
  return `${deliveryMethodLabel(n.method)} needs ${list}.`;
}

export function deliveryIsEmpty(d: Partial<Delivery> | null | undefined): boolean {
  const n = normalizeDelivery(d);
  return !n.method && !n.address && !n.contactName && !n.contactPhone && !n.notes;
}

export function sameDelivery(a: Partial<Delivery> | null | undefined, b: Partial<Delivery> | null | undefined): boolean {
  const x = normalizeDelivery(a);
  const y = normalizeDelivery(b);
  return (Object.keys(x) as (keyof Delivery)[]).every(k => x[k] === y[k]);
}

/** Short label for a chip: "Ship · UPS Ground", "Onsite install", … */
export function deliveryChipLabel(d: Partial<Delivery> | null | undefined): string | null {
  const n = normalizeDelivery(d);
  switch (n.method) {
    case 'direct_ship': return `Ship · ${deliveryShipSpeedLabel(n.shipSpeed)?.replace(/^UPS /, '') || 'speed not set'}`;
    case 'onsite_install': return n.installer === 'cni' ? 'Onsite install · CNI' : 'Onsite install';
    case 'customer_pickup': return 'Customer pick-up';
    case 'bmg_shop': return 'BMG shop';
    default: return null;
  }
}

/** Chip color per method (hex — used in inline styles on dark and light). */
export function deliveryChipColor(method: string | null | undefined): string {
  switch (method) {
    case 'onsite_install': return '#f87171';
    case 'customer_pickup': return '#fbbf24';
    case 'bmg_shop': return '#34d399';
    default: return '#38bdf8';
  }
}

/** Labelled lines for print (packing list, estimate PDF/approval page). */
export function deliveryLines(d: Partial<Delivery> | null | undefined): { label: string; value: string }[] {
  const n = normalizeDelivery(d);
  if (!n.method) return [];
  const lines: { label: string; value: string }[] = [{ label: 'Delivery', value: deliveryMethodLabel(n.method)! }];
  const contact = [n.contactName, n.contactPhone].filter(Boolean).join(' · ');
  if (n.method === 'direct_ship') {
    if (n.shipSpeed) lines.push({ label: 'Speed', value: deliveryShipSpeedLabel(n.shipSpeed)! });
    if (n.address) lines.push({ label: 'Ship to', value: n.address });
    if (contact) lines.push({ label: 'Contact', value: contact });
    if (n.notes) lines.push({ label: 'Notes', value: n.notes });
  } else if (n.method === 'onsite_install') {
    if (n.address) lines.push({ label: 'Install at', value: n.address });
    if (contact) lines.push({ label: 'Contact', value: contact });
    if (n.installer) lines.push({ label: 'Installed by', value: deliveryInstallerLabel(n.installer)! });
    if (n.notes) lines.push({ label: 'Install notes', value: n.notes });
  } else if (n.method === 'customer_pickup') {
    if (contact) lines.push({ label: 'Contact', value: contact });
    if (n.notes) lines.push({ label: 'Instructions', value: n.notes });
  } else {
    lines.push({ label: 'Where', value: SHOP_INSTALL_LOCATION });
    if (n.notes) lines.push({ label: 'Notes', value: n.notes });
  }
  return lines;
}

/** One line for the older free-text places that show delivery: the
 *  estimate's delivery_preferences (NetSuite memo, estimate PDF and
 *  approval page, check-in snapshot, pick list). */
export function deliveryText(d: Partial<Delivery> | null | undefined): string | null {
  // Who installs is ours to know; this text reaches the customer.
  const lines = deliveryLines(d).filter(l => l.label !== 'Installed by');
  if (lines.length === 0) return null;
  const flat = (v: string) => v.split('\n').map(x => x.trim()).filter(Boolean).join(', ');
  const [first, ...rest] = lines;
  return [first.value, ...rest.map(l => `${l.label}: ${flat(l.value)}`)].join(' · ').slice(0, 2000);
}

/** The Install Location a method implies on a graphics job, or undefined to
 *  leave the job's own choice alone. */
export function installLocationForDelivery(d: Partial<Delivery> | null | undefined): string | undefined {
  const n = normalizeDelivery(d);
  if (n.method === 'bmg_shop') return SHOP_INSTALL_LOCATION;
  if (n.method === 'onsite_install') return n.installer === 'cni' ? 'CNI Installer' : 'Customer Site';
  return undefined;
}

/** A customer's default ship-to (customers.default_ship_to JSON) as a
 *  multi-line address block, for prefilling. */
export function formatShipToBlock(s: { name?: string; address?: string; city?: string; state?: string; zip?: string } | null | undefined): string | null {
  if (!s) return null;
  const cityLine = [s.city, [s.state, s.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const block = [s.name, s.address, cityLine].map(x => (x || '').trim()).filter(Boolean).join('\n');
  return block || null;
}
