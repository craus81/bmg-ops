/**
 * The notification type registry (R6-13) — every alert this app can send,
 * named once.
 *
 * WHY THIS EXISTS. Preferences were resolved by SUBSTRING MATCH on the type
 * string: `type.includes('new')` consulted notify_new_job,
 * `type.includes('ready')` consulted notify_ready, and everything that
 * matched nothing fell through to "allow". That produced three separate
 * lies on the Settings page:
 *
 *   * Toggles that governed types nobody would guess. `cni_photos_ready`
 *     was silenced by "Ready" — a graphics-production toggle turning off a
 *     contract-installer alert.
 *   * A toggle that governed NOTHING: no notification type in the codebase
 *     contains the word "shipped", so "Shipped" has never changed a thing.
 *   * Roughly fifty types with no toggle at all, quietly always-on, while
 *     the page implied the four switches covered notifications.
 *
 * So the registry is the source of truth, and `notification-registry.test.ts`
 * greps every notify()/notifyMany() call site in src/ and FAILS when a type
 * is dispatched that is not catalogued here. Without that test this file
 * would drift back into a partial list, and a partial list is exactly the
 * dishonesty it replaces — a missing type would silently be "allowed"
 * again.
 *
 * TWO LAYERS, KEPT APART. Some existing flags decide WHO is targeted at all
 * (notify_new_po, notify_ready_for_install, notify_invoicing,
 * email_mentions, notify_weekly_brief — read at the call site when it picks
 * recipients); the channel preferences decide HOW someone already targeted
 * hears about it. Presenting an audience flag as a channel checkbox would
 * suggest ticking it subscribes you to something, which it does not. The
 * registry records which is which in `audience`.
 */

export type NotifyChannelKey = 'in_app' | 'push' | 'email';

export type NotificationArea =
  | 'sales' | 'graphics' | 'floor' | 'purchasing'
  | 'money' | 'cni' | 'digests' | 'system' | 'messages';

export const AREA_LABEL: Record<NotificationArea, string> = {
  sales: 'Sales & quotes',
  graphics: 'Graphics & proofs',
  floor: 'Shop floor & vehicles',
  purchasing: 'Purchasing & receiving',
  money: 'Invoicing & money',
  cni: 'Contract installers',
  digests: 'Digests & briefings',
  system: 'System & health',
  messages: 'Messages & mentions',
};

/** Display order for the Settings matrix. */
export const AREA_ORDER: NotificationArea[] = [
  'sales', 'graphics', 'floor', 'purchasing', 'money', 'cni', 'digests', 'system', 'messages',
];

export interface NotificationTypeDef {
  type: string;
  label: string;
  description: string;
  area: NotificationArea;
  /** Channels used when the user has expressed no preference for this type. */
  defaultChannels: NotifyChannelKey[];
  /**
   * Set when the type bypasses per-user channel preferences entirely
   * (src/lib/notify.ts ALWAYS_ALL_CHANNELS). The matrix renders these
   * locked WITH this reason rather than as checkboxes that do nothing.
   */
  alwaysOn?: string;
  /**
   * Set when a separate flag or role decides whether you are targeted at
   * all. Stated on the row, because a channel checkbox cannot subscribe
   * you to something you are not in the audience for.
   */
  audience?: string;
}

export const NOTIFICATION_TYPES: NotificationTypeDef[] = [
  // ── Sales & quotes ────────────────────────────────────────────────────
  { type: 'quote_followup', label: 'Quote needs a follow-up', description: 'A sent quote has gone quiet and is due a chase.', area: 'sales', defaultChannels: ['in_app', 'push'] },
  { type: 'prospect_reminder', label: 'Lead follow-up due', description: 'A reminder you set on a prospect has come round.', area: 'sales', defaultChannels: ['in_app', 'push'] },
  { type: 'deal_overdue', label: 'Deal past its close date', description: 'An opportunity is still open past when it was expected to close.', area: 'sales', defaultChannels: ['in_app', 'push'] },
  { type: 'pipeline_movement', label: 'Deal changed stage', description: 'An opportunity moved forward or back in the pipeline.', area: 'sales', defaultChannels: ['in_app'] },
  { type: 'at_risk_account', label: 'Account at risk', description: 'A customer that used to order regularly has gone quiet.', area: 'sales', defaultChannels: ['in_app', 'push'] },
  { type: 'estimate_converted', label: 'Estimate became an order', description: 'A customer-approved estimate turned into a sales order.', area: 'sales', defaultChannels: ['in_app', 'push'] },
  { type: 'below_floor_send', label: 'Quote sent below the margin floor', description: 'An estimate went out under the floor, with the reason given.', area: 'sales', defaultChannels: ['in_app', 'push'], audience: 'Owners only — super admins are the targeted audience for floor breaches.' },
  { type: 'approval_relink_requested', label: 'Customer asked for a fresh link', description: 'A customer found their approval link expired and requested a new one.', area: 'sales', defaultChannels: ['in_app', 'push'] },
  { type: 'credit_app_submitted', label: 'Credit application submitted', description: 'A customer completed the credit application.', area: 'sales', defaultChannels: ['in_app', 'push', 'email'] },
  { type: 'incoming_call', label: 'Incoming call matched', description: 'Caller ID matched a customer or lead on an inbound call.', area: 'sales', defaultChannels: ['in_app', 'push'] },

  // ── Graphics & proofs ─────────────────────────────────────────────────
  { type: 'graphics_new', label: 'New graphics job', description: 'A graphics job was created.', area: 'graphics', defaultChannels: ['in_app', 'push'] },
  { type: 'graphics_flagged', label: 'Graphics job flagged', description: 'A job came in needing someone to confirm it before work starts.', area: 'graphics', defaultChannels: ['in_app', 'push'] },
  { type: 'graphics_status', label: 'Graphics job changed status', description: 'A job moved between production stages.', area: 'graphics', defaultChannels: ['in_app'] },
  { type: 'graphics_activity', label: 'Activity on a graphics job', description: 'A note, file or change landed on a job you follow.', area: 'graphics', defaultChannels: ['in_app'] },
  { type: 'graphics', label: 'Graphics job update', description: 'General update on a graphics job.', area: 'graphics', defaultChannels: ['in_app'] },
  { type: 'graphics_ready_for_pickup', label: 'Job ready for pickup', description: 'Finished work is packed and waiting to be collected.', area: 'graphics', defaultChannels: ['in_app', 'push'] },
  { type: 'graphics_ready_for_install', label: 'Vehicle ready to install', description: 'Graphics are ready and the matched vehicle can be scheduled.', area: 'graphics', defaultChannels: ['in_app', 'push', 'email'], alwaysOn: 'Always sent on every channel — it releases work to the floor.', audience: 'Assigned installers, admins, and anyone who opted in with "Install-Ready Alerts".' },
  { type: 'proof_sent', label: 'Proof sent to the customer', description: 'An artwork proof went out for approval.', area: 'graphics', defaultChannels: ['in_app'] },
  { type: 'proof_approved', label: 'Proof approved', description: 'The customer signed off on the artwork.', area: 'graphics', defaultChannels: ['in_app', 'push'] },
  { type: 'proof_stale', label: 'Proof waiting too long', description: 'A proof has sat unanswered long enough to block production.', area: 'graphics', defaultChannels: ['in_app', 'push'] },

  // ── Shop floor & vehicles ─────────────────────────────────────────────
  { type: 'assignment', label: 'Assigned to you', description: 'A job or vehicle was assigned to you.', area: 'floor', defaultChannels: ['in_app', 'push', 'email'], alwaysOn: 'Always sent on every channel — it is work handed directly to you.' },
  { type: 'vehicle_arrived', label: 'Vehicle arrived', description: 'A vehicle was checked in at the shop.', area: 'floor', defaultChannels: ['in_app', 'push'] },
  { type: 'vehicle_complete', label: 'Vehicle finished', description: 'A vehicle passed QC and is ready to go back.', area: 'floor', defaultChannels: ['in_app', 'push'] },
  { type: 'booking', label: 'Drop-off or pickup booked', description: 'A customer booked a slot, or one changed.', area: 'floor', defaultChannels: ['in_app', 'push'] },
  { type: 'shift_auto_closed', label: 'Shift closed automatically', description: 'A shift was left open and the nightly sweep closed it.', area: 'floor', defaultChannels: ['in_app'] },
  { type: 'labor_burn', label: 'Labor over the quoted hours', description: 'A job has burned past the hours it was quoted at.', area: 'floor', defaultChannels: ['in_app', 'push'] },
  { type: 'condition_acknowledged', label: 'Condition report acknowledged', description: 'The customer confirmed the vehicle condition at drop-off.', area: 'floor', defaultChannels: ['in_app'] },
  { type: 'condition_disputed', label: 'Condition report disputed', description: 'The customer disagreed with the recorded condition — read this one.', area: 'floor', defaultChannels: ['in_app', 'push', 'email'] },

  // ── Purchasing & receiving ────────────────────────────────────────────
  { type: 'purchase_request', label: 'Parts requested', description: 'Someone raised a purchase request for parts.', area: 'purchasing', defaultChannels: ['in_app', 'push'] },
  { type: 'purchase_request_stale', label: 'Purchase request going stale', description: 'A request has waited too long without a PO.', area: 'purchasing', defaultChannels: ['in_app', 'push'] },
  { type: 'po_received', label: 'PO received', description: 'Parts arrived against a purchase order.', area: 'purchasing', defaultChannels: ['in_app', 'push'], audience: 'Users who opted in with "New Purchase Orders".' },
  { type: 'po_eta_changed', label: 'PO delivery date moved', description: 'A vendor changed the promised arrival on an open PO.', area: 'purchasing', defaultChannels: ['in_app', 'push'] },
  { type: 'auto_reorder', label: 'Stock hit its reorder point', description: 'An item dropped to the level where it needs reordering.', area: 'purchasing', defaultChannels: ['in_app', 'push'] },
  { type: 'price_drift', label: 'Part cost moved', description: 'A part is being bought at a materially different price than before.', area: 'purchasing', defaultChannels: ['in_app'] },

  // ── Invoicing & money ─────────────────────────────────────────────────
  { type: 'graphics_invoice_prompt', label: 'Job needs invoicing', description: 'Work shipped and no invoice exists yet.', area: 'money', defaultChannels: ['in_app', 'push'], audience: 'Admins who opted in with "Invoicing Alerts".' },
  { type: 'graphics_invoice_created', label: 'Invoice created', description: 'An invoice was raised in NetSuite for a job.', area: 'money', defaultChannels: ['in_app'], audience: 'Admins who opted in with "Invoicing Alerts".' },
  { type: 'ap_submitted', label: 'Bill submitted for approval', description: 'A vendor bill needs someone to approve it.', area: 'money', defaultChannels: ['in_app', 'push'] },
  { type: 'ap_approved', label: 'Bill approved', description: 'A vendor bill cleared approval.', area: 'money', defaultChannels: ['in_app'] },
  { type: 'ap_decision', label: 'Bill decision recorded', description: 'A bill was approved or rejected, with the reason.', area: 'money', defaultChannels: ['in_app'] },
  { type: 'ap_paid', label: 'Bill paid', description: 'A vendor bill was marked paid.', area: 'money', defaultChannels: ['in_app'] },
  { type: 'email_bounced', label: 'Customer email bounced', description: 'A message to a customer could not be delivered.', area: 'money', defaultChannels: ['in_app', 'push'] },
  { type: 'invoice_email_bounced', label: 'Invoice email bounced', description: 'An invoice never reached the customer — they are not going to pay it.', area: 'money', defaultChannels: ['in_app', 'push', 'email'] },
  { type: 'estimate_email_bounced', label: 'Estimate email bounced', description: 'An estimate never reached the customer.', area: 'money', defaultChannels: ['in_app', 'push'] },

  // ── Contract installers (CNI) ─────────────────────────────────────────
  { type: 'cni_job_invite', label: 'Job invitation', description: 'An installer company was invited to bid on a job.', area: 'cni', defaultChannels: ['in_app', 'push'] },
  { type: 'cni_invite_reminder', label: 'Invitation reminder', description: 'An invited company has not answered yet.', area: 'cni', defaultChannels: ['in_app', 'push'] },
  { type: 'cni_invite_sla', label: 'Invitation past its SLA', description: 'An invitation has gone unanswered past the response window.', area: 'cni', defaultChannels: ['in_app', 'push'] },
  { type: 'cni_job_bid', label: 'Bid received', description: 'An installer company submitted a bid.', area: 'cni', defaultChannels: ['in_app', 'push'] },
  { type: 'cni_assigned', label: 'Installer assigned', description: 'A job was awarded to an installer company.', area: 'cni', defaultChannels: ['in_app', 'push'] },
  { type: 'cni_schedule_proposed', label: 'Install date proposed', description: 'A date was proposed for a contract install.', area: 'cni', defaultChannels: ['in_app', 'push'] },
  { type: 'cni_schedule_declined', label: 'Install date declined', description: 'The proposed install date was turned down.', area: 'cni', defaultChannels: ['in_app', 'push'] },
  { type: 'cni_job_complete', label: 'Contract install finished', description: 'An installer marked the job complete.', area: 'cni', defaultChannels: ['in_app', 'push'] },
  { type: 'cni_checklist_complete', label: 'Install checklist finished', description: 'Every required checklist step on a contract install is done.', area: 'cni', defaultChannels: ['in_app'] },
  { type: 'cni_photos_ready', label: 'Install photos submitted', description: 'An installer uploaded their completion photos for review.', area: 'cni', defaultChannels: ['in_app', 'push'] },
  { type: 'cni_photo_denied', label: 'Install photo rejected', description: 'A submitted photo was rejected and needs retaking.', area: 'cni', defaultChannels: ['in_app', 'push'] },
  { type: 'cni_docs_complete', label: 'Installer paperwork complete', description: 'An installer finished their onboarding documents.', area: 'cni', defaultChannels: ['in_app'] },
  { type: 'cni_compliance', label: 'Installer compliance problem', description: 'Insurance or an agreement has lapsed or is about to.', area: 'cni', defaultChannels: ['in_app', 'push'] },
  { type: 'cni_budget', label: 'Contract job over budget', description: 'A contract install has run past its budgeted cost.', area: 'cni', defaultChannels: ['in_app', 'push'] },
  { type: 'cni_payout', label: 'Installer payout update', description: 'A payout was batched, billed or paid.', area: 'cni', defaultChannels: ['in_app', 'push'] },

  // ── Digests & briefings ───────────────────────────────────────────────
  { type: 'owner_brief', label: "Monday owner's brief", description: 'The weekly money-and-operations summary.', area: 'digests', defaultChannels: ['in_app', 'email'], audience: 'Super admins and executives only, minus anyone who opted out in Settings.' },
  { type: 'exceptions_digest', label: 'Weekly exceptions digest', description: 'Overrides, waivers and exceptions from the past week.', area: 'digests', defaultChannels: ['in_app', 'email'] },
  { type: 'promised_back_digest', label: 'Promised-back digest', description: 'Vehicles due back, and the ones already late.', area: 'digests', defaultChannels: ['in_app', 'push'] },

  // ── System & health ───────────────────────────────────────────────────
  { type: 'system_health', label: 'System health alert', description: 'A background job, integration or probe reported a problem.', area: 'system', defaultChannels: ['in_app', 'push', 'email'] },
  { type: 'access_request', label: 'Access request', description: 'Someone asked for an account or extra permissions.', area: 'system', defaultChannels: ['in_app', 'push'] },

  // ── Messages & mentions ───────────────────────────────────────────────
  { type: 'message', label: 'Direct message', description: 'Someone messaged you in the app.', area: 'messages', defaultChannels: ['in_app'], alwaysOn: 'In-app always on — messages appear in the chat regardless. Email is the "Email me my messages" switch.' },
];

const BY_TYPE = new Map(NOTIFICATION_TYPES.map(t => [t.type, t]));

export function getNotificationType(type: string): NotificationTypeDef | undefined {
  return BY_TYPE.get(type);
}

export function isRegistered(type: string): boolean {
  return BY_TYPE.has(type);
}

/** Types grouped for the Settings matrix, areas in display order. */
export function typesByArea(): Array<{ area: NotificationArea; label: string; types: NotificationTypeDef[] }> {
  return AREA_ORDER
    .map(area => ({
      area,
      label: AREA_LABEL[area],
      types: NOTIFICATION_TYPES.filter(t => t.area === area),
    }))
    .filter(group => group.types.length > 0);
}

/** The per-type override map stored on notification_preferences.type_channels. */
export type TypeChannelOverrides = Record<string, NotifyChannelKey[]>;

export function parseOverrides(raw: unknown): TypeChannelOverrides {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: TypeChannelOverrides = {};
  for (const [type, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const channels = value.filter((c): c is NotifyChannelKey => c === 'in_app' || c === 'push' || c === 'email');
    // An empty array is a real choice — "send me nothing on this type" —
    // and must survive the round trip, so it is kept, not dropped.
    out[type] = [...new Set(channels)];
  }
  return out;
}

export interface ChannelPrefsRow {
  notify_in_app?: boolean | null;
  notify_email?: boolean | null;
  type_channels?: unknown;
}

/**
 * The channels one user wants for one type. Precedence, most specific
 * first:
 *
 *   1. alwaysOn — the type ignores preferences by design.
 *   2. a per-type override the user set in the matrix.
 *   3. the account-wide in-app/email switches, applied to the type's
 *      defaults, so a user who has only ever used the old switches keeps
 *      exactly the behaviour they had.
 *   4. the type's defaults, for a user with no preferences row at all.
 *
 * An UNREGISTERED type returns its channels unfiltered rather than [] —
 * failing open. Silently dropping an alert nobody catalogued is the worse
 * error, and the registry test exists so this branch stays unreachable.
 */
export function channelsForType(
  type: string,
  prefs: ChannelPrefsRow | null | undefined,
  fallback: NotifyChannelKey[] = ['in_app', 'push'],
): NotifyChannelKey[] {
  const def = BY_TYPE.get(type);
  if (!def) return fallback;
  if (def.alwaysOn) return def.defaultChannels;
  if (!prefs) return def.defaultChannels;

  const overrides = parseOverrides(prefs.type_channels);
  if (Object.prototype.hasOwnProperty.call(overrides, type)) return overrides[type];

  const inApp = prefs.notify_in_app !== false;
  const email = prefs.notify_email === true;
  return def.defaultChannels.filter(c => {
    if (c === 'email') return email;
    // Push rides with in-app: they are the same switch on two surfaces.
    return inApp;
  });
}
