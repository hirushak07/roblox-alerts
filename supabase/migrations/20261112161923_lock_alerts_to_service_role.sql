-- Only the Edge Function (service_role) needs this table for now.
-- The app gets its own, narrower access later (select + a policy).
revoke all on table public.alerts from anon, authenticated;
