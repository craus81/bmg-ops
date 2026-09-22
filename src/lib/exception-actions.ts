/**
 * Every audit_log action that records a human overriding a guard the app
 * would otherwise enforce. Adding a new override capture? Put its action
 * here so the weekly exceptions digest (R4-5) and the owner's brief (R5-7)
 * both surface it — audit rows nobody reads are why those exist.
 */
export const EXCEPTION_ACTIONS: string[] = [
  'convert_to_so_override',
  'status_forced',
  'invoice_allow_additional',
  'vendor_bill_variance_override',
  'estimate_below_floor_sent',
  'estimate_edit_after_approval',
  'estimate_delete_after_approval',
  'so_push_after_edit',
  'prospect_netsuite_relink',
  'labor_item_changed',
  'sales_tax_rate_changed',
  'shop_labor_rate_changed',
  'cni_assign_noncompliant',
];

export const ACTION_LABELS: Record<string, string> = {
  convert_to_so_override: 'SO created without customer approval',
  status_forced: 'vehicle status forced past a gate',
  invoice_allow_additional: 'invoice billed past the already-invoiced guard',
  vendor_bill_variance_override: 'vendor bill posted past a failed three-way match',
  estimate_below_floor_sent: 'estimate sent below the margin floor',
  estimate_edit_after_approval: 'approved estimate edited',
  estimate_delete_after_approval: 'approved estimate deleted',
  so_push_after_edit: 'SO re-pushed after post-approval edits',
  prospect_netsuite_relink: 'customer NetSuite link changed',
  labor_item_changed: 'NetSuite labor item changed',
  sales_tax_rate_changed: 'sales tax rate changed',
  shop_labor_rate_changed: 'shop labor rate changed',
  cni_assign_noncompliant: 'CNI work given to a non-compliant installer',
};
