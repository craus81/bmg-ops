export type AppRole = 'admin' | 'installer' | 'field_tech' | 'shop_tech' | 'sales' | 'graphics_production' | 'customer';

// Human-readable labels for roles
export const ROLE_LABELS: Record<AppRole, string> = {
  admin: 'Admin',
  installer: 'Installer (Pre-Approval)',
  field_tech: 'Field Tech',
  shop_tech: 'Shop Tech (O\'Fallon)',
  sales: 'Sales',
  graphics_production: 'Graphics / Production',
  customer: 'Customer',
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
  status: 'open' | 'complete' | 'cancelled' | 'closed';
  ordered_date: string | null;
  notes: string | null;
  ship_to: { name?: string; address?: string; city?: string; state?: string; zip?: string } | null;
  created_by: string;
  created_at: string;
  line_items?: POLineItem[];
}

export interface POLineItem {
  id: string;
  po_id: string;
  catalog_id: string;
  part_number: string;
  description: string | null;
  quantity: number;
  installed: number;
  unit_price: number;
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
  matched_graphics_job_id?: string | null;
  calendar_event_id?: string | null;
  invoice_number?: string | null;
  date_invoiced?: string | null;
  is_paid?: boolean;
  created_at: string;
  updated_at: string;
}

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
  | 'shipped'
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
  shipped: 'Shipped',
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
  shipped: '#3b82f6',
  installed: '#22c55e',
  cancelled: '#6b7280',
};

export const GRAPHICS_STATUS_ORDER: GraphicsJobStatus[] = [
  'flagged', 'received', 'designing', 'revision', 'printing',
  'outgassing', 'cutting', 'packing', 'ready', 'shipped', 'installed', 'cancelled',
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
  calendar_event_id: string | null;
  supplier: string | null;
  proof_url: string | null;
  created_by: string | null;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
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

export interface NotificationPreferences {
  id: string;
  user_id: string;
  notify_new_job: boolean;
  notify_status_change: boolean;
  notify_ready: boolean;
  notify_ready_for_install?: boolean;
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
