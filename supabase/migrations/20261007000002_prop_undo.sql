-- A bet with a player prop can be undone like any other (the owner's call, 2026-10-07):
-- within the undo window, before its first game starts, and while none of its lines has
-- moved. Its game lines are checked against a fresh pull as before; its props against
-- the latest props import, since prop lines only change when the owner's pulls come in.
-- So a prop can be taken back after news the latest import doesn't show yet.

create or replace function public.undo_slip_internal(
  p_slip uuid, p_user uuid, p_check_only boolean default false, p_lines_since timestamptz default null
) returns timestamptz
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v public.slips%rowtype;
  v_doc jsonb;
  v_now timestamptz;
  v_checked boolean;
  v_fetched_after timestamptz;
  v_moved boolean;
  v_game_legs boolean;
begin
  perform 1 from public.entries e join public.slips s on s.entry_id = e.id where s.id = p_slip for no key update of e;
  select * into v from public.slips where id = p_slip for update;
  if not found or not app.manages(v.entry_id, p_user) then raise exception 'not_found'; end if;
  if v.status <> 'pending' then raise exception 'not_pending'; end if;
  if not exists (select 1 from public.league_weeks where league_id = v.league_id and week = v.week and status = 'open') then
    raise exception 'week_closed';
  end if;
  v_now := clock_timestamp();
  select document into v_doc from public.rule_sets where version = v.rule_set_version;
  if v_now > v.placed_at + make_interval(secs => coalesce((v_doc ->> 'undoMinutes')::numeric, 0) * 60) then raise exception 'undo_window_passed'; end if;
  if app.slip_locks_at(v.id) <= v_now then raise exception 'game_started'; end if;
  v_checked := not coalesce((v_doc ->> 'undoAfterLineMove')::boolean, false);
  -- Only game lines can be pulled fresh. A prop leg is checked against the latest props
  -- import, so a bet of props alone needs no pull.
  v_game_legs := exists (select 1 from public.slip_legs l where l.slip_id = v.id and l.player is null);
  if p_check_only then return case when v_checked and v_game_legs then v_now end; end if;
  if v_checked then
    select (select lp.fetched_after from public.line_pulls lp where lp.kind = 'lines' and lp.ok order by lp.at desc limit 1),
           exists (
             select 1
             from public.slip_legs l
             left join public.current_lines cl
               on l.player is null and cl.game_id = l.game_id and cl.market = l.market and cl.side = l.side
             left join public.current_props cp
               on l.player is not null and cp.game_id = l.game_id and cp.market = l.market and cp.player = l.player and cp.side = l.side
             where l.slip_id = v.id
               and case
                 when l.player is not null then cp.game_id is null or cp.point is distinct from l.point or cp.price <> l.price
                 else cl.game_id is null
                      or cl.point is distinct from l.point
                      or (cl.price <> l.price
                          and v.type <> 'teaser'
                          and not (v_doc -> 'pricing' ->> 'straight' = 'flat' and l.market <> 'moneyline'))
               end
           )
      into v_fetched_after, v_moved;
    if v_game_legs and (p_lines_since is null or p_lines_since > v_now or p_lines_since < v_now - interval '2 minutes'
       or coalesce(v_fetched_after < p_lines_since, true)) then
      raise exception 'undo_lines_stale';
    end if;
    if v_moved then raise exception 'undo_line_moved'; end if;
  end if;
  update public.slips set status = 'undone', undone_at = v_now where id = p_slip;
  insert into public.ledger (entry_id, amount_cents, kind, slip_id, week, created_by)
  values (v.entry_id, v.stake_cents, 'undo', v.id, v.week, p_user);
  return v_now;
end $$;
