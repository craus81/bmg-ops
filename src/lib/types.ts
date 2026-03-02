export interface Profile {
  id: string;
  full_name: string;
  email: string;
  role: 'admin' | 'installer';
  status?: 'pending' | 'approved' | 'denied';
  requested_role?: string;
  company_id?: string;
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
  status: 'open' | 'complete' | 'cancelled';
  notes: string | null;
  created_by: string;
  created_at: string;
  line_items?: POLineItem[];
}

export interface POLineItem {
  id: string;
  po_id: string;
  catalog_id: string;
  part_number: string;
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
  panels?: QuotePanel[];
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
  panels: AIPanelResult[];
  total_vinyl_sqft: number;
  total_vehicle_sqft: number;
  overall_coverage_pct: number;
  confidence: string;
  notes: string;
}

export interface AIPanelResult {
  panel_name: string;
  panel_area_sqft: number;
  vinyl_coverage_pct: number;
  vinyl_sqft: number;
  vinyl_type: string;
  description: string;
}
