-- Who can read and call what.
--
-- Signed-out visitors (anon) get nothing. Signed-in members (authenticated) can read
-- through Row Level Security and call only the member and admin functions listed
-- here. Nobody writes a table directly: every change goes through a function.
-- The Edge Functions use the service role, which bypasses RLS.
--
-- Any function added later must be revoked from anon/authenticated and granted
-- explicitly, because Supabase grants execute on new functions by default.

alter table public.league_settings enable row level security;
alter table public.profiles enable row level security;
alter table public.entries enable row level security;
alter table public.entry_managers enable row level security;
alter table public.rule_sets enable row level security;
alter table public.weeks enable row level security;
alter table public.teams enable row level security;
alter table public.games enable row level security;
alter table public.book_lines enable row level security;
alter table public.line_history enable row level security;
alter table public.line_overrides enable row level security;
alter table public.line_pulls enable row level security;
alter table public.slips enable row level security;
alter table public.slip_legs enable row level security;
alter table public.ledger enable row level security;
alter table public.week_entry_status enable row level security;
alter table public.entry_baselines enable row level security;
alter table public.audit_log enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant select on all tables in schema public to authenticated;

-- League-wide information every member can read.
create policy members_read on public.league_settings for select to authenticated using (true);
create policy members_read on public.profiles for select to authenticated using (true);
create policy members_read on public.entries for select to authenticated using (true);
create policy members_read on public.entry_managers for select to authenticated using (true);
create policy members_read on public.rule_sets for select to authenticated using (true);
create policy members_read on public.weeks for select to authenticated using (true);
create policy members_read on public.teams for select to authenticated using (true);
create policy members_read on public.games for select to authenticated using (true);
create policy members_read on public.book_lines for select to authenticated using (true);
create policy members_read on public.line_history for select to authenticated using (true);
create policy members_read on public.line_overrides for select to authenticated using (true);
create policy members_read on public.line_pulls for select to authenticated using (true);
create policy members_read on public.week_entry_status for select to authenticated using (true);
create policy members_read on public.entry_baselines for select to authenticated using (true);
create policy members_read on public.audit_log for select to authenticated using (true);

-- Bets: your own entries' bets always; everyone else's only once revealed.
-- Admins get no exception.
create policy slips_read on public.slips for select to authenticated
  using (app.can_see_slip(id));
create policy legs_read on public.slip_legs for select to authenticated
  using (app.can_see_leg(slip_id, game_id));
-- Ledger rows tied to a hidden bet (its stake, an undo) stay hidden with it.
create policy ledger_read on public.ledger for select to authenticated
  using (app.manages(entry_id) or slip_id is null or app.can_see_slip(slip_id));

grant select on public.current_lines to authenticated;

-- Functions.
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema app from public, anon, authenticated;
grant usage on schema app to authenticated, service_role;

-- Used inside the RLS policies above.
grant execute on function app.manages(uuid, uuid) to authenticated;
grant execute on function app.can_see_slip(uuid) to authenticated;
grant execute on function app.can_see_leg(uuid, uuid) to authenticated;

-- Member functions.
grant execute on function public.undo_slip(uuid) to authenticated;
grant execute on function public.set_display_name(text) to authenticated;
grant execute on function public.my_entries() to authenticated;
grant execute on function public.standings(timestamptz, timestamptz) to authenticated;
grant execute on function public.hidden_activity(int) to authenticated;

-- Admin functions (each checks the caller is an admin).
grant execute on function public.admin_open_next_week(text) to authenticated;
grant execute on function public.admin_add_entry(text, bigint) to authenticated;
grant execute on function public.admin_import_splash(uuid, bigint, bigint, int, int, int, bigint, bigint, bigint, text) to authenticated;
grant execute on function public.admin_adjust_bank(uuid, bigint, text) to authenticated;
grant execute on function public.admin_set_manager(uuid, uuid, boolean) to authenticated;
grant execute on function public.admin_set_admin(uuid, boolean) to authenticated;
grant execute on function public.admin_set_line(uuid, text, numeric, int, numeric, int, boolean, text) to authenticated;
grant execute on function public.admin_clear_line(uuid, text, text) to authenticated;
grant execute on function public.admin_set_game_status(uuid, text, timestamptz, text) to authenticated;
grant execute on function public.admin_set_final_score(uuid, int, int, text) to authenticated;
grant execute on function public.admin_move_game(uuid, int, text) to authenticated;
grant execute on function public.admin_void_slip(uuid, text) to authenticated;
grant execute on function public.admin_list_users() to authenticated;

-- Edge Functions only.
grant execute on all functions in schema public to service_role;
grant execute on all functions in schema app to service_role;
