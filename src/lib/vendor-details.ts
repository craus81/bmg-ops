/**
 * A vendor's details changed in FleetSuite and sent on to NetSuite (Books
 * part 41, migration 473, docs/books.md "Customer and vendor details changed
 * in FleetSuite"; owner decisions 2026-10-31, thread "Replacing NetSuite
 * with FleetSuite": from January 1, 2027 the team works only in FleetSuite,
 * apart from payments, deposits and banking).
 *
 * From More → Money & Books → Vendor Details, a vendor's
 *
 *   - email and phone;
 *   - terms, from NetSuite's list of them (the copy, gl_netsuite_lists),
 *     what its new bills default to;
 *   - addresses: one changed, one added, and which one is its billing
 *     address (NetSuite's default billing address);
 *   - 1099 details: whether it gets a 1099, its legal name as on its W-9,
 *     and its tax ID.
 *
 * A tax ID is never kept in FleetSuite: NetSuite is sent the one typed, and
 * the screen, the change's record and the audit log only ever say the four
 * digits it ends with (`taxIdEnding`, `keptBody`). The database refuses a
 * record of a change that holds more of it (migration 473).
 *
 * Each address is changed by NetSuite's id for its line, as the Customer
 * Record's Edit panel changes a customer's (updateCustomer in netsuite.ts):
 * no line is taken off, and one sent without an id is added.
 *
 * Pure, so the page and the route agree on what changes and what NetSuite is
 * sent.
 */

export const REASON_MAX = 300;
export const EMAIL_MAX = 254;
export const PHONE_MAX = 32;
export const LEGAL_NAME_MAX = 100;
/** Each address field's length at most, as the screen takes them. */
export const ADDRESS_MAX = { addressee: 100, attention: 100, addr1: 150, addr2: 150, city: 50, state: 30, zip: 20 } as const;
/** The line id the page gives the address it adds. */
export const NEW_LINE = 'new';

export type AddressField = keyof typeof ADDRESS_MAX;
export const ADDRESS_FIELDS = Object.keys(ADDRESS_MAX) as AddressField[];

export type AddressText = Record<AddressField, string>;

export interface VendorAddressLine extends AddressText {
  /** NetSuite's id for the line in the vendor's address book; null when it gave none, so it can't be changed. */
  lineId: string | null;
  /** Its billing address: NetSuite's default billing address. */
  defaultBilling: boolean;
  defaultShipping: boolean;
  label: string;
  /** What else NetSuite has on the address, sent back as it is when the address changes. */
  addr3: string;
  addrPhone: string;
  country: string | null;
}

export interface DetailsVendor {
  id: string;
  name: string;
  entityId: string;
  isPerson: boolean;
  inactive: boolean;
  email: string;
  phone: string;
  termsId: string | null;
  termsName: string | null;
  /** Whether it gets a 1099; null when NetSuite didn't say. */
  is1099: boolean | null;
  legalName: string;
  /** Whether NetSuite has a tax ID for it; null when NetSuite didn't say. */
  hasTaxId: boolean | null;
  /** The four digits its tax ID ends with, and never the rest. */
  taxIdEnding: string | null;
  addresses: VendorAddressLine[];
}

export interface TermsOption { id: string; name: string }

/** An address as typed: an existing line's (its NetSuite id) or the one added (NEW_LINE). */
export interface VendorAddressEdit extends AddressText {
  lineId: string;
}

/** What the page sends: only what was changed. */
export interface VendorDetailsEdit {
  reason: string;
  email?: string;
  phone?: string;
  termsId?: string;
  is1099?: boolean;
  legalName?: string;
  /** A new tax ID, typed. Never kept. */
  taxId?: string;
  addresses?: VendorAddressEdit[];
  /** The line that's its billing address: an existing line's id, or NEW_LINE for the address added. */
  billingLineId?: string;
}

export interface VendorDetailsPlan {
  /** What NetSuite is sent. */
  body: Record<string, unknown>;
  /** What FleetSuite keeps of it: the same, a tax ID only as the four digits it ends with. */
  keptBody: Record<string, unknown>;
  /** What changes, a sentence each. */
  changes: string[];
  problems: string[];
  notes: string[];
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? '' : String(v).trim());
const flag = (v: unknown): boolean | null => (v === true || v === 'T' ? true : v === false || v === 'F' ? false : null);
/** A select field: REST answers { id, refName }, or now and then the bare id. */
const refId = (v: any): string | null => {
  const id = v && typeof v === 'object' ? v.id : v;
  return id !== null && id !== undefined && /^\d+$/.test(String(id)) ? String(id) : null;
};
const refName = (v: any): string | null => (v && typeof v === 'object' && v.refName ? String(v.refName) : null);
const countryOf = (v: any): string | null => {
  const id = v && typeof v === 'object' ? v.id : v;
  return id ? String(id) : null;
};
/** The address sub-record on an address book line, under the three spellings REST has used (see addressBookLineAddress in netsuite.ts). */
const lineAddress = (item: any): any => item?.addressBookAddress || item?.addressbookAddress || item?.addressbookaddress || {};

/** The digits a tax ID is made of, typed or read. */
const digitsOf = (v: string) => v.replace(/\D/g, '');

/** The vendor's record as NetSuite's REST GET gives it (expandSubResources), its tax ID only as its last four digits. */
export function parseDetailsVendor(record: any): DetailsVendor {
  const r = record ?? {};
  const person = [text(r.firstName), text(r.lastName)].filter(Boolean).join(' ');
  // NetSuite may give it whole or masked, as ***-**-6789: any of it at all means it has one.
  const tax = r.taxIdNum === undefined ? null : text(r.taxIdNum);
  const taxDigits = tax ? digitsOf(tax) : '';
  const items: any[] = Array.isArray(r.addressBook?.items) ? r.addressBook.items : [];
  const addresses = items.map((item): VendorAddressLine => {
    const a = lineAddress(item);
    const id = item?.id ?? item?.internalId;
    return {
      lineId: id === null || id === undefined || String(id).trim() === '' ? null : String(id),
      defaultBilling: flag(item?.defaultBilling) === true,
      defaultShipping: flag(item?.defaultShipping) === true,
      label: text(item?.label),
      addressee: text(a.addressee),
      attention: text(a.attention),
      addr1: text(a.addr1),
      addr2: text(a.addr2),
      city: text(a.city),
      state: text(a.state) || refName(a.state) || '',
      zip: text(a.zip),
      addr3: text(a.addr3),
      addrPhone: text(a.addrPhone),
      country: countryOf(a.country),
    };
  });
  return {
    id: text(r.id),
    name: text(r.companyName) || person || text(r.entityId) || `Vendor ${text(r.id)}`,
    entityId: text(r.entityId),
    isPerson: flag(r.isPerson) === true,
    inactive: flag(r.isInactive) === true,
    email: text(r.email),
    phone: text(r.phone),
    termsId: refId(r.terms),
    termsName: refName(r.terms),
    is1099: flag(r.is1099Eligible),
    legalName: text(r.legalName),
    hasTaxId: tax === null ? null : tax.length > 0,
    taxIdEnding: taxDigits.length >= 4 ? taxDigits.slice(-4) : null,
    addresses,
  };
}

/**
 * What a change of the vendor is worked out from, in a line: anything different means it changed in NetSuite while
 * the page was open. Its tax ID goes in only as its last four digits.
 */
export function vendorFacts(v: DetailsVendor): string {
  return JSON.stringify([
    v.id, v.name, v.email, v.phone, v.termsId, v.is1099, v.legalName, v.hasTaxId, v.taxIdEnding,
    v.addresses.map((a) => [a.lineId, a.defaultBilling, a.defaultShipping, ...ADDRESS_FIELDS.map((f) => a[f]), a.addr3, a.addrPhone, a.country]),
  ]);
}

/** An address on one line, as the screen and the changes say it. */
export function addressLine(a: Partial<AddressText>): string {
  const cityLine = [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [a.addressee, a.attention ? `Attn ${a.attention}` : '', a.addr1, a.addr2, cityLine].filter(Boolean).join(', ') || '(blank)';
}

/** Its billing address now: the line marked so, or with a single address, that one. Null when it can't be told. */
export function billingLine(v: DetailsVendor): VendorAddressLine | null {
  const marked = v.addresses.filter((a) => a.defaultBilling);
  if (marked.length === 1) return marked[0];
  if (marked.length === 0 && v.addresses.length === 1) return v.addresses[0];
  return null;
}

export const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

/** A tax ID as NetSuite takes one: nine digits, as 12-3456789, 123-45-6789 or 123456789. Null when it isn't one. */
export function taxIdOf(typed: string): string | null {
  const v = typed.replace(/\s/g, '');
  return /^(\d{9}|\d{2}-\d{7}|\d{3}-\d{2}-\d{4})$/.test(v) ? v : null;
}

/**
 * NetSuite's words about a change, with the tax ID it was sent taken out however it's written, in case it quotes it
 * back: they're kept with the change and shown on the screen, and a tax ID never is.
 */
export function withoutTaxId(said: string, sent: unknown): string {
  const digits = typeof sent === 'string' ? digitsOf(sent) : '';
  if (digits.length < 9) return said;
  return said.replace(new RegExp(digits.split('').join('[-\\s]?'), 'g'), '(the tax ID)');
}

const yesNo = (v: boolean | null) => (v === null ? 'not said' : v ? 'yes' : 'no');
const shown = (v: string) => v || '(none)';

/** The address as typed, trimmed. */
const typedAddress = (a: AddressText): AddressText =>
  Object.fromEntries(ADDRESS_FIELDS.map((f) => [f, (a[f] ?? '').trim()])) as AddressText;

const sameAddress = (a: AddressText, b: AddressText) => ADDRESS_FIELDS.every((f) => a[f] === b[f]);

/** What each address field is called in a sentence. */
const FIELD_NAMES: Record<AddressField, string> = {
  addressee: 'name', attention: 'attention line', addr1: 'street', addr2: 'second line', city: 'city', state: 'state', zip: 'zip',
};

/** Works out what changes, what NetSuite is sent and what's kept of it, or what's in the way. */
export function planVendorDetails(
  vendor: DetailsVendor,
  edit: VendorDetailsEdit,
  facts: { terms: ReadonlyMap<string, TermsOption> },
): VendorDetailsPlan {
  const body: Record<string, unknown> = {};
  const changes: string[] = [];
  const problems: string[] = [];
  const notes: string[] = [];
  let taxEnding: string | null = null;

  if (edit.email !== undefined) {
    const v = edit.email.trim();
    if (v !== vendor.email) {
      if (v.length > EMAIL_MAX) problems.push(`The email takes ${EMAIL_MAX} characters at most.`);
      else if (v && !isEmail(v)) problems.push(`"${v}" doesn't look like an email address.`);
      else {
        body.email = v;
        changes.push(`Email ${shown(vendor.email)} → ${shown(v)}`);
      }
    }
  }

  if (edit.phone !== undefined) {
    const v = edit.phone.trim();
    if (v !== vendor.phone) {
      if (v.length > PHONE_MAX) problems.push(`The phone takes ${PHONE_MAX} characters at most.`);
      else if (v && digitsOf(v).length < 7) problems.push(`"${v}" is too short to be a phone number.`);
      else {
        body.phone = v;
        changes.push(`Phone ${shown(vendor.phone)} → ${shown(v)}`);
      }
    }
  }

  if (edit.termsId !== undefined && edit.termsId !== (vendor.termsId ?? '')) {
    const terms = facts.terms.get(edit.termsId);
    if (!edit.termsId) problems.push("Terms can't be taken off here: pick the terms it should have.");
    else if (!terms) problems.push("Pick terms from NetSuite's list of them.");
    else {
      body.terms = { id: terms.id };
      changes.push(`Terms ${vendor.termsId ? vendor.termsName || facts.terms.get(vendor.termsId)?.name || `Terms ${vendor.termsId}` : '(none)'} → ${terms.name}`);
    }
  }

  if (edit.is1099 !== undefined && edit.is1099 !== vendor.is1099) {
    body.is1099Eligible = edit.is1099;
    changes.push(`Gets a 1099: ${yesNo(vendor.is1099)} → ${yesNo(edit.is1099)}`);
  }

  if (edit.legalName !== undefined) {
    const v = edit.legalName.trim();
    if (v !== vendor.legalName) {
      if (v.length > LEGAL_NAME_MAX) problems.push(`The legal name takes ${LEGAL_NAME_MAX} characters at most.`);
      else {
        body.legalName = v;
        changes.push(`Legal name ${shown(vendor.legalName)} → ${shown(v)}`);
      }
    }
  }

  if (edit.taxId !== undefined && edit.taxId.trim() !== '') {
    const v = taxIdOf(edit.taxId);
    if (!v) problems.push('A tax ID is nine digits, as 12-3456789 or 123-45-6789.');
    else {
      body.taxIdNum = v;
      taxEnding = digitsOf(v).slice(-4);
      const was = vendor.taxIdEnding ? `ending ${vendor.taxIdEnding}` : vendor.hasTaxId ? 'on file' : '(none)';
      changes.push(`Tax ID ${was} → one ending ${taxEnding}`);
    }
  }

  // ── Addresses ────────────────────────────────────────────────────────────
  const items = new Map<string, Record<string, unknown>>();
  const itemFor = (key: string) => {
    let item = items.get(key);
    if (!item) {
      item = key === NEW_LINE ? {} : { id: key };
      items.set(key, item);
    }
    return item;
  };
  const lines = new Map(vendor.addresses.filter((a) => a.lineId).map((a) => [a.lineId!, a]));
  const seen = new Set<string>();
  let added: AddressText | null = null;

  for (const e of edit.addresses ?? []) {
    const typed = typedAddress(e);
    if (seen.has(e.lineId)) { problems.push(e.lineId === NEW_LINE ? 'One change adds one address at most.' : 'An address was sent twice.'); continue; }
    seen.add(e.lineId);
    const long = ADDRESS_FIELDS.find((f) => typed[f].length > ADDRESS_MAX[f]);
    if (long) { problems.push(`An address's ${FIELD_NAMES[long]} takes ${ADDRESS_MAX[long]} characters at most.`); continue; }

    if (e.lineId === NEW_LINE) {
      if (!typed.addr1 || !typed.city) { problems.push('A new address needs its street and city.'); continue; }
      added = typed;
      const item = itemFor(NEW_LINE);
      // The vendor's first address is its billing and shipping address.
      if (vendor.addresses.length === 0) Object.assign(item, { defaultBilling: true, defaultShipping: true });
      item.addressBookAddress = { ...typed, country: { id: 'US' } };
      changes.push(`New address: ${addressLine(typed)}`);
      continue;
    }

    const line = lines.get(e.lineId);
    if (!line) { problems.push(`An address changed in NetSuite since this page opened. Reload it and try again.`); continue; }
    if (sameAddress(typed, line)) continue;
    if (!typed.addr1 || !typed.city) { problems.push(`${addressLine(line)}: an address needs its street and city.`); continue; }
    // Everything NetSuite has on the address goes back, so nothing on it is lost whether NetSuite merges or replaces it.
    itemFor(e.lineId).addressBookAddress = {
      ...typed,
      addr3: line.addr3,
      addrPhone: line.addrPhone,
      ...(line.country ? { country: { id: line.country } } : {}),
    };
    changes.push(`Address ${addressLine(line)} → ${addressLine(typed)}`);
  }

  if (edit.billingLineId !== undefined) {
    const now = billingLine(vendor);
    const target = edit.billingLineId === NEW_LINE ? added : lines.get(edit.billingLineId) ?? null;
    if (edit.billingLineId === NEW_LINE && !added) problems.push('Add the new address to make it the billing address.');
    else if (!target) problems.push(`An address changed in NetSuite since this page opened. Reload it and try again.`);
    else if (edit.billingLineId === NEW_LINE ? vendor.addresses.length > 0 : now?.lineId !== edit.billingLineId || !now.defaultBilling) {
      itemFor(edit.billingLineId).defaultBilling = true;
      for (const a of vendor.addresses) {
        if (a.defaultBilling && a.lineId && a.lineId !== edit.billingLineId) itemFor(a.lineId).defaultBilling = false;
      }
      const shownAddress = edit.billingLineId === NEW_LINE ? added! : typedOrLine(edit, lines.get(edit.billingLineId)!);
      changes.push(`Billing address ${now ? addressLine(now) : '(none)'} → ${addressLine(shownAddress)}`);
    }
  }
  if (items.size > 0) body.addressBook = { items: [...items.values()] };

  // ── The rest ─────────────────────────────────────────────────────────────
  const gets1099 = edit.is1099 ?? vendor.is1099;
  if (gets1099 && vendor.hasTaxId === false && !taxEnding) notes.push('It gets a 1099 and NetSuite has no tax ID for it: its 1099 needs one, from its W-9.');

  const reason = edit.reason.trim();
  if (!reason) problems.push("Say why it's being changed.");
  else if (reason.length > REASON_MAX) problems.push(`Why it's being changed takes ${REASON_MAX} characters at most.`);
  if (changes.length === 0 && problems.length === 0) problems.push('Nothing has changed yet.');

  const keptBody = taxEnding ? { ...body, taxIdNum: `(ending ${taxEnding})` } : { ...body };
  return { body, keptBody, changes, problems, notes };
}

/** A line's address as this change leaves it: as typed when it's being changed too. */
function typedOrLine(edit: VendorDetailsEdit, line: VendorAddressLine): AddressText {
  const e = (edit.addresses ?? []).find((x) => x.lineId === line.lineId);
  return e ? typedAddress(e) : line;
}
