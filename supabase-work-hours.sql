-- CleanBid: add work_hours column to quotes (Site Survey work-hours persistence)
-- Run in the Supabase dashboard SQL editor. Idempotent — safe to re-run.
-- (Agent cannot run migrations; this is for the user to apply.)

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS work_hours JSONB
  DEFAULT '{"start":"8:00 AM","end":"5:00 PM","overnight":false}'::jsonb;

COMMENT ON COLUMN quotes.work_hours IS
  'Editable facility operating hours captured in the Site Survey (start, end, overnight flag). Not a pricing input.';
