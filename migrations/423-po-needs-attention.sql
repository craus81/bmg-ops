-- Migration 423: a "needs attention" flag on purchase orders.
--
-- Craig (2026-10-21, thread "Flagging a PO that needs attention"): the team
-- needs to mark an imported customer PO (Masterack) as still having
-- something to finish, so it stands out on the PO list. One flag per PO: an
-- optional short note of what's needed, who set it and when. Done clears it
-- (the note is copied into po_notes so the history stays).

ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS attention_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attention_note TEXT,
  ADD COLUMN IF NOT EXISTS attention_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS attention_by_name TEXT;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_attention
  ON public.purchase_orders (attention_at) WHERE attention_at IS NOT NULL;
