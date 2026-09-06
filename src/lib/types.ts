export type AppRole = 'admin' | 'super_admin' | 'executive' | 'installer' | 'field_tech' | 'shop_tech' | 'sales' | 'graphics_production' | 'customer' | 'finance';

// Human-readable labels for roles
export const ROLE_LABELS: Record<AppRole, string> = {
  admin: 'Admin',
  super_admin: 'Super Admin',
  executive: 'Executive',
  installer: 'Installer (Pre-Approval)',
  field_tech: 'Field Tech',
  shop_tech: 'Shop Tech (O\'Fallon)',
  sales: 'Sales',
  graphics_production: 'Graphics / Production',
  customer: 'Customer',
  finance: 'Finance / AP',
};

// Legacy role mapping for backward compatibility
export const LEGACY_ROLE_MAP: Record<string, AppRole> = {
  production: 'graphics_production',
};

export interface Profile {
  id: string;
  full_name: string;
  email: string;
  role: AppRole;
  roles?: AppRole[];
  status?: 'pending' | 'approved' | 'denied';
  requested_role?: string;
  company_id?: string;
  deactivated?: boolean;
}

export interface CatalogItem {
  id: string;
  part_number: string;
  /** Which Parts Catalog tab the part lives on (netsuite_parts.catalog). */
  catalog?: 'upfit' | 'graphics';
  customer: string;
  end_customer: string;
  vehicle_type: string;
  graphic_package: string;
  price: number;
  proof_pages: number;
  active: boolean;
}

export interface CatalogProof {
  id: string;
  catalog_id: string;
  part_number: string;
  file_name: string;
  file_path: string;
  file_type: string;
  file_size: number | null;
  label: string | null;
  sort_order: number;
  uploaded_by: string | null;
  created_at: string;
}

export interface PurchaseOrder {
  id: string;
  po_number: string;
  customer: string;
  /** NetSuite customer internal id resolved from `customer` (null = unresolved free text). */
  customer_netsuite_id?: string | null;
  status: 'open' | 'complete' | 'cancelled' | 'closed';
  ordered_date: string | null;
  requested_delivery_date: string | null;
  notes: string | null;
  ship_to: { name?: string; address?: string; city?: string; state?: string; zip?: string } | null;
  /** Buyer Information off the PO PDF (migration 256). */
  buyer_name?: string | null;
  buyer_email?: string | null;
  /** Automatic receipt confirmation (src/lib/po-confirmation.ts). */
  confirmation_sent_at?: string | null;
  confirmation_sent_to?: string[] | null;
  created_by: string;
  created_at: string;
  line_items?: POLineItem[];
  /** Invoiced-quantity check verdict (null = unchecked). */
  invoice_check_status?: 'ok' | 'attention' | 'no_invoices' | null;
  /** Details behind invoice_check_status — see migrations/137. */
  invoice_check?: {
    checked_at: string;
    invoice_count: number;
    problems: string[];
    lines: { part_number: string; ordered: number; invoiced: number; status: 'ok' | 'over' | 'under' | 'extra' }[];
  } | null;
}

export interface POLineItem {
  id: string;
  po_id: string;
  catalog_id: string;
  part_id: string | null;
  part_number: string;
  description: string | null;
  quantity: number;
  installed: number;
  unit_price: number;
}

export interface PoLocation {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  archived: boolean;
  created_at: string;
}

export interface ScannedVehicle {
  id: string;
  vin: string;
  vehicle_year: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_trim: string | null;
  body_class: string | null;
  part_number: string | null;
  customer: string | null;
  end_customer: string | null;
  catalog_id: string | null;
  po_line_item_id: string | null;
  company_id?: string;
  denial_count?: number;
  install_location?: string;
  scanned_by: string;
  scanned_at: string;
  photos?: VehiclePhoto[];
}

export interface VehiclePhoto {
  id: string;
  vehicle_id: string;
  storage_path: string;
  photo_type: 'completion' | 'before' | 'during' | 'damage';
  taken_by: string;
  taken_at: string;
}

export interface TimeEntry {
  id: string;
  user_id: string;
  clock_in: string;
  clock_out: string | null;
  status: 'clocked_in' | 'on_break' | 'clocked_out';
  total_ms: number | null;
  breaks?: TimeBreak[];
}

export interface TimeBreak {
  id: string;
  time_entry_id: string;
  break_start: string;
  break_end: string | null;
  break_type: 'lunch' | 'other';
}

// ============ Quoting / Estimating ============

export interface VehicleTemplate {
  id: string;
  name: string;
  make: string;
  model: string;
  year: string | null;
  variant: string | null;
  scale: string;
  overall_length_in: number | null;
  overall_height_in: number | null;
  wheelbase_in: number | null;
  template_image_path: string | null;
  original_file_path: string | null;
  panel_data: PanelDimension[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PanelDimension {
  name: string;
  width_in: number;
  height_in: number;
  area_sqft: number;
}

export interface Quote {
  id: string;
  quote_number: string;
  customer_name: string;
  vehicle_description: string | null;
  template_id: string | null;
  proof_image_path: string | null;
  status: 'draft' | 'sent' | 'accepted' | 'declined' | 'expired';
  ai_analysis: AIAnalysisResult | null;
  total_vinyl_sqft: number;
  coverage_percentage: number;
  material_cost_per_sqft: number;
  labor_cost_per_sqft: number;
  material_total: number;
  labor_total: number;
  subtotal: number;
  markup_percentage: number;
  total_price: number;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  analysis_version?: string;
  nesting_result?: RollNestingResult | null;
  panels?: QuotePanel[];
  elements?: QuoteElement[];
  template?: VehicleTemplate;
}

export interface QuotePanel {
  id: string;
  quote_id: string;
  panel_name: string;
  panel_area_sqft: number;
  vinyl_coverage_pct: number;
  vinyl_sqft: number;
  vinyl_type: string | null;
  notes: string | null;
  sort_order: number;
}

export interface AIAnalysisResult {
  panels?: AIPanelResult[];
  graphic_elements?: GraphicElement[];
  total_vinyl_sqft: number;
  total_vehicle_sqft: number;
  overall_coverage_pct: number;
  confidence: string;
  notes: string;
  analysis_version?: 'panel_coverage' | 'individual_elements';
}

export interface AIPanelResult {
  panel_name: string;
  panel_area_sqft: number;
  vinyl_coverage_pct: number;
  vinyl_sqft: number;
  vinyl_type: string;
  description: string;
}

// ============ Element-Based Quoting ============

export interface GraphicElement {
  element_name: string;
  element_type: string;
  width_in: number;
  height_in: number;
  description: string;
  panel?: string;
  // Crop region in the proof image (percentages of image dimensions)
  crop_x_pct?: number;
  crop_y_pct?: number;
  crop_w_pct?: number;
  crop_h_pct?: number;
}

export interface ElementWithBleed {
  element: GraphicElement;
  bleed_in: number;
  total_width_in: number;
  total_height_in: number;
}

export interface NestedElement {
  element: GraphicElement;
  bleed_in: number;
  total_width_in: number;
  total_height_in: number;
  x_in: number;
  y_in: number;
  rotated?: boolean;
}

export interface RollNestingResult {
  roll_width_in: number;
  roll_length_in: number;
  roll_area_sqft: number;
  nested_elements: NestedElement[];
  efficiency_pct: number;
}

export interface QuoteElement {
  id: string;
  quote_id: string;
  element_name: string;
  element_type: string | null;
  width_in: number;
  height_in: number;
  description: string | null;
  bleed_in: number;
  nested_x_in: number | null;
  nested_y_in: number | null;
  sort_order: number;
}

// ============ Fleet Check-In / Vehicle Tracking ============

export type VehicleTrackingStatus = 'received' | 'in_progress' | 'stuck_parts' | 'stuck_graphics' | 'complete' | 'shipped';

export const VEHICLE_STATUS_PIPELINE: VehicleTrackingStatus[] = [
  'received', 'in_progress', 'stuck_parts', 'stuck_graphics', 'complete', 'shipped'
];

// "Physically on the ground at the shop" — the statuses the In-Shop board's
// On Ground count, ShopArrivals, and the estimate builder's checked-in
// vehicle picker all agree on ('checked_in' is the pre-migration alias of
// 'received' that old rows can still carry). Pair with archived_at IS NULL.
export const IN_SHOP_STATUSES = ['received', 'checked_in', 'in_progress', 'stuck_parts', 'stuck_graphics'];

export const VEHICLE_STATUS_LABELS: Record<VehicleTrackingStatus, string> = {
  received: 'Received',
  in_progress: 'In Progress',
  stuck_parts: 'Stuck (Parts)',
  stuck_graphics: 'Stuck (Graphics)',
  complete: 'Complete',
  shipped: 'Shipped',
};

export const VEHICLE_STATUS_COLORS: Record<VehicleTrackingStatus, { bg: string; border: string; text: string }> = {
  received: { bg: 'rgba(99,102,241,0.08)', border: 'rgba(99,102,241,0.25)', text: '#818cf8' },
  in_progress: { bg: 'rgba(59,130,246,0.08)', border: 'rgba(59,130,246,0.25)', text: '#60a5fa' },
  stuck_parts: { bg: 'rgba(251,191,36,0.08)', border: 'rgba(251,191,36,0.25)', text: '#fbbf24' },
  stuck_graphics: { bg: 'rgba(251,146,60,0.08)', border: 'rgba(251,146,60,0.25)', text: '#fb923c' },
  complete: { bg: 'rgba(52,211,153,0.08)', border: 'rgba(52,211,153,0.25)', text: '#34d399' },
  shipped: { bg: 'rgba(139,92,246,0.08)', border: 'rgba(139,92,246,0.25)', text: '#a78bfa' },
};

export interface FleetCheckin {
  id: string;
  vin: string;
  vehicle_year: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_trim: string | null;
  body_class: string | null;
  netsuite_sales_order_id: string | null;
  sales_order_number: string | null;
  customer_name: string | null;
  /** The customers row behind customer_name (migration 220) — set by the
   *  check-in picker, or resolved from the SO's customer name. Older rows
   *  carry only the name. */
  customer_id?: string | null;
  sales_order_memo: string | null;
  sales_order_total: number | null;
  proof_file_path: string | null;
  proof_file_name: string | null;
  proof_thumbnail_path: string | null;
  notes: string | null;
  status: VehicleTrackingStatus | 'checked_in';
  assigned_to: string | null;
  customer_portal_token: string | null;
  checked_in_by: string;
  company_id?: string;
  scheduled_upfit_date?: string | null;
  /** When the customer needs the vehicle back — drives In-Shop due-risk chips. */
  promised_back_date?: string | null;
  matched_graphics_job_id?: string | null;
  calendar_event_id?: string | null;
  invoice_number?: string | null;
  date_invoiced?: string | null;
  is_paid?: boolean;
  // Graphics install lane (migration 085) — runs in parallel to status above
  graphics_install_status?: GraphicsInstallStatus;
  graphics_install_completed_at?: string | null;
  graphics_install_completed_by?: string | null;
  graphics_install_notes?: string | null;
  created_at: string;
  updated_at: string;
}

// One row per linked NetSuite sales order on a fleet check-in. The first
// row added is mirrored back into the FleetCheckin legacy columns so
// pick lists, search, etc. still see "a" sales order. Additional rows
// only live here.
export interface CheckinSalesOrder {
  id: string;
  checkin_id: string;
  netsuite_sales_order_id: string;
  sales_order_number: string | null;
  customer_name: string | null;
  sales_order_memo: string | null;
  sales_order_total: number | null;
  added_by: string | null;
  added_at: string;
}

export type GraphicsInstallStatus = 'pending' | 'in_progress' | 'stuck' | 'complete' | 'n/a';

export const GRAPHICS_INSTALL_PIPELINE: GraphicsInstallStatus[] = [
  'pending', 'in_progress', 'stuck', 'complete', 'n/a',
];

export const GRAPHICS_INSTALL_LABELS: Record<GraphicsInstallStatus, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  stuck: 'Stuck',
  complete: 'Complete',
  'n/a': 'N/A',
};

export const GRAPHICS_INSTALL_COLORS: Record<GraphicsInstallStatus, { bg: string; border: string; text: string }> = {
  pending:     { bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.40)', text: '#94a3b8' },
  in_progress: { bg: 'rgba(167,139,250,0.15)', border: 'rgba(167,139,250,0.45)', text: '#a78bfa' },
  stuck:       { bg: 'rgba(249,115,22,0.15)',  border: 'rgba(249,115,22,0.45)',  text: '#f97316' },
  complete:    { bg: 'rgba(34,197,94,0.15)',   border: 'rgba(34,197,94,0.45)',   text: '#22c55e' },
  'n/a':       { bg: 'rgba(100,116,139,0.10)', border: 'rgba(100,116,139,0.35)', text: '#64748b' },
};

export interface VehicleStatusHistory {
  id: string;
  vehicle_id: string;
  from_status: VehicleTrackingStatus | null;
  to_status: VehicleTrackingStatus;
  note: string | null;
  changed_by: string;
  changed_by_name: string | null;
  created_at: string;
}

export interface GraphicsProof {
  id: string;
  customer_name: string;
  vehicle_type: string | null;
  file_name: string;
  storage_path: string;
  thumbnail_path: string | null;
  file_size: number | null;
  file_type: string;
  uploaded_by: string | null;
  created_at: string;
}

export interface NetsuiteSalesOrder {
  id: string;
  sales_order_number: string;
  record_type?: 'Sales Order' | 'Invoice' | 'Estimate';
  date: string;
  vin: string | null;
  status: string;
  // Per-type display label from NetSuite (absent on rows reconstructed
  // from fleet_checkin_sales_orders, which doesn't store status).
  status_label?: string;
  customer_id: string;
  customer_name: string;
  memo: string | null;
  total: number | null;
  line_items: NetsuiteSalesOrderLine[];
}

export interface NetsuiteSalesOrderLine {
  line_number: number;
  item_name: string | null;
  description: string | null;
  quantity: number;
  rate: number;
  amount: number;
}

// ═══════════ GRAPHICS PRODUCTION ═══════════

export type GraphicsJobStatus =
  | 'flagged'
  | 'received'
  | 'designing'
  | 'revision'
  | 'printing'
  | 'outgassing'
  | 'cutting'
  | 'packing'
  | 'ready'
  | 'ready_to_pickup'
  | 'shipped'
  | 'picked_up'
  | 'installed'
  | 'cancelled';

export const GRAPHICS_STATUS_LABELS: Record<GraphicsJobStatus, string> = {
  flagged: 'Flagged for Review',
  received: 'Job Received',
  designing: 'Designing',
  revision: 'In Revision',
  printing: 'Printing',
  outgassing: 'Outgassing',
  cutting: 'Cutting',
  packing: 'Packing',
  ready: 'Ready to Install',
  ready_to_pickup: 'Ready for Pickup',
  shipped: 'Shipped',
  picked_up: 'Picked Up',
  installed: 'Installed',
  cancelled: 'Cancelled',
};

export const GRAPHICS_STATUS_COLORS: Record<GraphicsJobStatus, string> = {
  flagged: '#f59e0b',
  received: '#60a5fa',
  designing: '#a78bfa',
  revision: '#f97316',
  printing: '#34d399',
  outgassing: '#67e8f9',
  cutting: '#fbbf24',
  packing: '#c084fc',
  ready: '#4ade80',
  ready_to_pickup: '#0ea5e9',
  shipped: '#3b82f6',
  picked_up: '#16a34a',
  installed: '#22c55e',
  cancelled: '#6b7280',
};

export const GRAPHICS_STATUS_ORDER: GraphicsJobStatus[] = [
  'flagged', 'received', 'designing', 'revision', 'printing',
  'outgassing', 'cutting', 'packing', 'ready', 'ready_to_pickup',
  'shipped', 'picked_up', 'installed', 'cancelled',
];

export type GraphicsJobCategory = 'production' | 'proofing' | 'internal' | 'customer_supplied';

export const GRAPHICS_CATEGORY_LABELS: Record<GraphicsJobCategory, string> = {
  production: 'Production',
  proofing: 'Proofing',
  internal: 'Internal',
  customer_supplied: 'Customer Supplied',
};

export const GRAPHICS_CATEGORY_COLORS: Record<GraphicsJobCategory, string> = {
  production: '#22c55e',
  proofing: '#a78bfa',
  internal: '#f59e0b',
  customer_supplied: '#3b82f6',
};

export interface GraphicsJob {
  id: string;
  po_id: string | null;
  po_line_item_id: string | null;
  job_number: string | null;
  job_category: GraphicsJobCategory;
  title: string;
  part_number: string | null;
  customer: string | null;
  quantity: number;
  content: string | null;
  notes: string | null;
  vinyl_type: string | null;
  vinyl_color: string | null;
  laminate: string | null;
  print_method: string | null;
  cut_method: string | null;
  premask: string | null;
  status: GraphicsJobStatus;
  tracking_number: string | null;
  carrier: string | null;
  ship_to: string | null;
  priority: 'low' | 'normal' | 'high' | 'rush';
  due_date: string | null;
  scheduled_install_date: string | null;
  /** Where the graphics get installed — "O'Fallon Shop" routes the job onto the shop arrival schedule. */
  install_location: string | null;
  calendar_event_id: string | null;
  supplier: string | null;
  proof_url: string | null;
  created_by: string | null;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
  // Estimate & Invoice linkage
  estimate_id: string | null;
  /** Proof files this job contributes to its linked estimate's customer
   *  surfaces (migration 235, mirrors wrap_quotes.estimate_attach):
   *  { file_ids: graphics_job_files ids }. Owned by the estimate
   *  send/approval routes — never write it from an edit form. */
  estimate_attach: { file_ids?: string[] } | null;
  // Source wrap quote (null unless spawned from / linked to one)
  wrap_quote_id: string | null;
  po_number: string | null;
  customer_netsuite_id: string | null;
  netsuite_invoice_id: string | null;
  netsuite_invoice_number: string | null;
  invoiced_at: string | null;
  invoiced_by: string | null;
  invoice_amount: number | null;
  invoice_pdf_url: string | null;
  // Parent upfit project (null for standalone graphics jobs)
  upfit_project_id: string | null;
  // Proof approval flow (migrations 084/090/154). These live on the row a
  // detail page loads, so they MUST be modeled here — an untyped rest-spread
  // of a job row once wrote stale copies of them back over live approvals.
  // Owned by the approval routes/cron; never write them from an edit form.
  approval_token: string | null;
  approval_token_expires_at: string | null;
  approval_proof_file_id: string | null;
  approval_reminder_sent_at: string | null;
  approval_reminder_count: number;
  approval_escalated_at: string | null;
  customer_approved: boolean;
  customer_approved_at: string | null;
  customer_rejected_at: string | null;
  customer_rejection_reason: string | null;
  sent_for_approval_at: string | null;
  sent_for_approval_by: string | null;
  signed_document_storage_path: string | null;
  signed_document_hash: string | null;
}

export interface GraphicsStatusHistory {
  id: string;
  job_id: string;
  from_status: string | null;
  to_status: string;
  changed_by: string | null;
  note: string | null;
  created_at: string;
}

export interface GraphicsJobView {
  id: string;
  job_id: string;
  user_id: string;
  first_viewed_at: string;
  last_viewed_at: string;
  view_count: number;
}

export interface NotificationPreferences {
  id: string;
  user_id: string;
  notify_new_job: boolean;
  notify_status_change: boolean;
  notify_ready: boolean;
  notify_ready_for_install?: boolean;
  notify_invoicing?: boolean;
  notify_shipped: boolean;
  notify_new_po: boolean;
  notify_in_app: boolean;
  notify_email: boolean;
  notify_sms: boolean;
  phone_number: string | null;
  custom_statuses: string[] | null;
  sms_messages: boolean;
  sms_messages_mode: 'always' | 'unread_only';
  email_messages: boolean;
  /** Opt-out (migration 254, default true): email on every @mention. Optional
   *  because rows written before the column existed read it as undefined. */
  email_mentions?: boolean;
}

// ═══════════ MESSAGING ═══════════

export interface Conversation {
  id: string;
  participant_1: string;
  participant_2: string;
  last_message_at: string;
  created_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  read_at: string | null;
  created_at: string;
  via_sms?: boolean;
  sms_sid?: string | null;
}
