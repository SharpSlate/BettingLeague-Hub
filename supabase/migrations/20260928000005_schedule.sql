-- Scheduled jobs on Supabase: pg_cron calls the Edge Functions through pg_net.
-- Lines: checked every 10 minutes; the function pulls every 30 minutes, or every 10 in
-- the 3 hours before a kickoff, and skips outside 8am-1am Eastern.
-- Scores and grading: every 10 minutes (the function only calls the Odds API while
-- a game is in progress or waiting on a final score).
--
-- The function URL and the shared cron secret live in Supabase Vault as
-- 'project_url' and 'cron_secret'; the deploy workflow stores them. Plain Postgres
-- (the tests) has no pg_cron, so the scheduling is skipped there.

create or replace function app.call_function(p_name text) returns bigint
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_url text;
  v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret';
  if v_url is null or v_secret is null then
    raise warning 'project_url or cron_secret missing from Vault; % not called', p_name;
    return null;
  end if;
  return net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/' || p_name,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    body := jsonb_build_object('trigger', 'schedule'),
    timeout_milliseconds := 60000
  );
end $$;

revoke execute on function app.call_function(text) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net with schema extensions;
    perform cron.schedule('pull-lines', '*/10 * * * *', 'select app.call_function(''pull-lines'')');
    perform cron.schedule('pull-scores', '*/10 * * * *', 'select app.call_function(''pull-scores'')');
  end if;
end $$;
