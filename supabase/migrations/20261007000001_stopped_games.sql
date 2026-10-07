-- A game stopped after kickoff voids its bets (the owner's call, 2026-10-07). Postponing
-- a game the score feed already shows under way voids it instead: every leg on it grades
-- void on the next run, stakes come back, and a parlay or teaser drops the leg. Its score
-- is ignored from then on, even if the game is finished later. A game postponed before it
-- started keeps its bets riding, as before.

-- Kickoffs: once any league has opened a game's week, its kickoff only moves later.
create or replace function public.admin_set_game_status(
  p_game uuid, p_status text, p_kickoff_at timestamptz, p_reason text
) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_actor uuid := app.require_admin();
  v_reason text := app.require_reason(p_reason);
  g public.games%rowtype;
  v_now timestamptz := clock_timestamp();
  v_reopened int := 0;
  v_status text := p_status;
begin
  select * into g from public.games where id = p_game for update;
  if not found then raise exception 'not_found'; end if;
  if p_status not in ('scheduled', 'postponed', 'void') then raise exception 'bad_status'; end if;
  if g.status = 'void' then raise exception 'game_void'; end if;
  if g.status = 'final' and p_status <> 'void' then raise exception 'game_final'; end if;
  if p_kickoff_at is not null and p_kickoff_at <> g.kickoff_at then
    if g.kickoff_at <= v_now then raise exception 'kickoff_passed'; end if;
    if p_kickoff_at <= v_now then raise exception 'kickoff_in_past'; end if;
    if p_kickoff_at < g.kickoff_at and exists (select 1 from public.league_weeks where week = g.week and status <> 'upcoming') then
      raise exception 'kickoff_earlier';
    end if;
  end if;
  if p_status = 'scheduled' and (g.status not in ('scheduled', 'postponed') or g.kickoff_at <= v_now) then
    raise exception 'game_started';
  end if;
  -- Stopped after kickoff: its bets are void.
  if p_status = 'postponed' and g.status = 'live' then
    v_status := 'void';
  end if;
  if v_status = 'void' and g.status = 'final' then
    v_reopened := app.reopen_graded(p_game, v_actor, v_reason);
  end if;
  update public.games
     set status = v_status,
         kickoff_at = coalesce(p_kickoff_at, kickoff_at),
         feed_final_home = null,
         feed_final_away = null,
         feed_kickoff = null,
         rescheduled_at = case when v_status = 'postponed' then rescheduled_at end,
         updated_at = v_now
   where id = p_game;
  perform app.audit(v_actor, 'game_status_set', 'game', p_game::text,
    jsonb_build_object('status', g.status, 'kickoffAt', g.kickoff_at),
    jsonb_build_object('status', v_status, 'kickoffAt', coalesce(p_kickoff_at, g.kickoff_at), 'betsRegraded', v_reopened)
      || case when v_status <> p_status then jsonb_build_object('stoppedAfterKickoff', true) else '{}'::jsonb end,
    v_reason);
end $$;
