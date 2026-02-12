export interface Profile {
  id: string;
  full_name: string;
  email: string;
  role: 'admin' | 'installer';
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
