-- Pin which estimate_files rode on the approval email.
--
-- The approval email and the approval page now carry download links for
-- the estimate PDF and the files the rep attached, served behind the
-- approval token (src/lib/estimate-approval-downloads.ts). The rep picks
-- those files on the compose screen at send time and nothing recorded the
-- choice, so a download link had no way to know which of the estimate's
-- files the customer was actually sent. Store the picked ids with the
-- token, so a file added to the estimate later never shows up on a link
-- the customer already holds.

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS approval_file_ids UUID[];
