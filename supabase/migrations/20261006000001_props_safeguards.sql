-- Safeguards for player props (owner's go-ahead, 2026-10-06), after a review of ways
-- to get an edge on them, carried over from the BMore Degen League site. Props are
-- still off in every league until its commissioner turns them on.
--
-- 1. Freshness: props can be bet only on lines pulled in the last 2 hours (was 18), and
--    within 90 minutes of a game's kickoff, when the teams have named their inactive
--    players, only on lines pulled after that.
-- 2. A player who isn't in the box score is no longer graded void as did not play: a
--    player who plays but records no stat isn't in ESPN's box score either, and voiding
--    him refunded overs and anytime TDs that should lose. His bets wait for a site
--    admin (Admin > Site feeds lists them), except when his props came off the board once
--    inactives were announced, which says he was ruled out.
-- 3. Box scores can also come from the owner's PC (import-boxes), since ESPN has refused
--    the site's own requests. An admin's stats for one player no longer make the
--    game's box score, which voided every other prop on the game.
-- 4. A bet with a player prop can't be undone (prop lines can't be re-checked on demand).
-- 5. A prop at a price no book would post for a main line is left off the board.
-- 6. Rules: an optional cap on props in one parlay (props.maxPerParlay), and safer
--    defaults for new leagues (rule set 1, the template).

-- ---------------------------------------------------------------- settings

alter table public.league_settings alter column prop_max_age_minutes set default 120;
-- Only the old default changes: there's no screen for this setting, so a different
-- value was set on purpose.
update public.league_settings set prop_max_age_minutes = 120 where id and prop_max_age_minutes = 1080;

-- ---------------------------------------------------------------- tables

alter table public.game_boxes drop constraint game_boxes_source_check;
alter table public.game_boxes add constraint game_boxes_source_check check (source in ('espn', 'feed', 'admin'));

-- Player props the grader can't settle without an admin, from its latest run: the player
-- isn't in the box score (missing), two players there have his name (ambiguous), only a
-- player with the same first initial and last name is there (name, with that player's
-- stats in candidate), or the box score couldn't be loaded (no_box).
create table public.prop_holds (
  game_id uuid not null references public.games (id) on delete cascade,
  player text not null check (length(player) between 1 and 80),
  why text not null check (why in ('missing', 'ambiguous', 'name', 'no_box')),
  candidate jsonb,
  -- How many pending bets are waiting on him.
  bets int not null default 0,
  since timestamptz not null default now(),
  primary key (game_id, player)
);
alter table public.prop_holds enable row level security;
revoke all on public.prop_holds from anon, authenticated;

-- ---------------------------------------------------------------- the board

create or replace view public.current_props with (security_invoker = true) as
with last_import as (
  select at, pulled_at from public.prop_imports where ok order by at desc limit 1
),
books as (
  select b.book, b.ord from public.league_settings s, unnest(s.books) with ordinality as b(book, ord)
),
offered as (
  select pl.game_id, pl.market, pl.player, pl.book, min(bk.ord) as ord
  from public.prop_lines pl
  join books bk on bk.book = pl.book
  join last_import li on pl.seen_at >= li.at
  group by pl.game_id, pl.market, pl.player, pl.book
  having count(*) = case when pl.market = 'anytime_td' then 1 else 2 end
     and count(distinct pl.point) = case when pl.market = 'anytime_td' then 0 else 1 end
     -- A price no book posts for a main line is a feed error, so that book's prop is left
     -- out (the next book's is used): an over/under's two prices must carry a normal
     -- margin (their implied chances add up to 100-120%), each between -300 and +250, and
     -- an anytime TD must be between -500 and +2500.
     and case when pl.market = 'anytime_td' then bool_and(pl.price between -500 and 2500)
              else bool_and(pl.price between -300 and 250)
                   and sum(case when pl.price < 0 then -pl.price::numeric / (100 - pl.price) else 100 / (pl.price + 100.0) end) between 1.0 and 1.2
         end
),
chosen as (
  select distinct on (game_id, market, player) game_id, market, player, book from offered order by game_id, market, player, ord
)
select pl.game_id, pl.market, pl.player, pl.side, pl.point, pl.price, pl.book as source, li.pulled_at as as_of
from public.prop_lines pl
join chosen c on c.game_id = pl.game_id and c.market = pl.market and c.player = pl.player and c.book = pl.book
cross join last_import li;

-- ---------------------------------------------------------------- placing

create or replace function public.place_slip_internal(
  p_entry uuid,
  p_user uuid,
  p_type text,
  p_teaser_points numeric,
  p_stake_cents bigint,
  p_quoted_american bigint,
  p_potential_payout_cents bigint,
  p_rule_set_version int,
  p_legs jsonb,
  p_client_ref uuid default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_league uuid;
  v_week public.league_weeks%rowtype;
  v_doc jsonb;
  v_props jsonb;
  v_settings public.league_settings%rowtype;
  v_last_pull timestamptz;
  v_props_pulled timestamptz;
  v_leg jsonb;
  v_game public.games%rowtype;
  v_line record;
  v_prop record;
  v_price int;
  v_slip uuid;
  v_n int;
  v_i int := 0;
  v_teased numeric;
  v_week_first timestamptz;
  v_now timestamptz;
  v_existing public.slips%rowtype;
  v_has_props boolean;
  v_step bigint;
  v_cap bigint;
begin
  -- "No key update" serializes everything that spends or counts an entry's units, but
  -- doesn't block the key-share locks that inserting a ledger row takes, so grading and
  -- corrections never wait on it.
  select league_id into v_league from public.entries where id = p_entry and status = 'active' for no key update;
  if not found then raise exception 'entry_not_active'; end if;
  if not app.manages(p_entry, p_user) then raise exception 'not_manager'; end if;
  if p_client_ref is not null then
    select * into v_existing from public.slips where client_ref = p_client_ref;
    if found then
      -- Only a retry of the same bet gets the bet back; the ref on a different bet, or on
      -- one that's been undone or voided since, is refused.
      if v_existing.entry_id <> p_entry or v_existing.placed_by <> p_user or v_existing.type <> p_type
         or v_existing.teaser_points is distinct from p_teaser_points
         or v_existing.stake_cents <> p_stake_cents or v_existing.leg_count <> jsonb_array_length(p_legs)
         or exists (
           select 1 from jsonb_array_elements(p_legs) x
           where not exists (select 1 from public.slip_legs l where l.slip_id = v_existing.id
                               and l.game_id::text = lower(x ->> 'gameId') and l.market = x ->> 'market' and l.side = x ->> 'side'
                               and l.player is not distinct from (x ->> 'player'))
         )
         or exists (
           select 1 from public.slip_legs l
           where l.slip_id = v_existing.id
             and not exists (select 1 from jsonb_array_elements(p_legs) x
                             where l.game_id::text = lower(x ->> 'gameId') and l.market = x ->> 'market' and l.side = x ->> 'side'
                               and l.player is not distinct from (x ->> 'player'))
         ) then
        raise exception 'client_ref_conflict';
      end if;
      if v_existing.status in ('undone', 'void') then raise exception 'client_ref_used'; end if;
      return v_existing.id;
    end if;
  end if;

  select * into v_week from public.league_weeks where league_id = v_league and status = 'open';
  if not found then raise exception 'no_open_week'; end if;
  if p_rule_set_version is distinct from v_week.rule_set_version then raise exception 'rules_changed'; end if;
  select document into v_doc from public.rule_sets where version = v_week.rule_set_version;
  select * into v_settings from public.league_settings;
  v_props := case when coalesce((v_doc -> 'props' ->> 'enabled')::boolean, false) then v_doc -> 'props' end;

  if p_type not in ('straight', 'parlay', 'teaser') then raise exception 'bad_type'; end if;
  if (p_type = 'teaser') <> (p_teaser_points is not null) then raise exception 'bad_teaser_points'; end if;
  if p_type = 'teaser' and not (v_doc -> 'betTypes' -> 'teaser' -> 'points') @> to_jsonb(p_teaser_points) then
    raise exception 'bad_teaser_points';
  end if;
  if not coalesce((v_doc -> 'betTypes' -> p_type ->> 'enabled')::boolean, false) then raise exception 'type_disabled'; end if;

  if jsonb_typeof(p_legs) is distinct from 'array' then raise exception 'no_legs'; end if;
  v_n := jsonb_array_length(p_legs);
  if p_type = 'straight' and v_n <> 1 then raise exception 'bad_leg_count'; end if;
  if p_type <> 'straight' and (
       v_n < (v_doc -> 'betTypes' -> p_type ->> 'minLegs')::int
    or v_n > (v_doc -> 'betTypes' -> p_type ->> 'maxLegs')::int) then
    raise exception 'bad_leg_count';
  end if;

  if p_stake_cents is null or p_stake_cents <= 0
     or p_stake_cents < round((v_doc -> 'stake' ->> 'minUnits')::numeric * 100)
     or p_stake_cents > round((v_doc -> 'stake' ->> 'maxUnits')::numeric * 100)
     or p_stake_cents % round((v_doc -> 'stake' ->> 'incrementUnits')::numeric * 100)::bigint <> 0 then
    raise exception 'stake_out_of_range';
  end if;

  -- Props: only where the league offers them, never in a teaser, at most the props stake
  -- limit, within a game either all props (up to props.maxPerGame of them) or none, and
  -- one pick per player (slip_legs_one_per_player backs that up).
  v_has_props := exists (select 1 from jsonb_array_elements(p_legs) x where app.is_prop(x ->> 'market'));
  if v_has_props then
    if v_props is null then raise exception 'props_off'; end if;
    if p_type = 'teaser' then raise exception 'bad_market'; end if;
    v_step := round((v_doc -> 'stake' ->> 'incrementUnits')::numeric * 100)::bigint;
    v_cap := floor(floor(round((v_doc -> 'stake' ->> 'maxUnits')::numeric * 100) * (v_props ->> 'maxStakePct')::numeric / 100) / v_step) * v_step;
    if p_stake_cents > v_cap then raise exception 'stake_out_of_range'; end if;
    if exists (
      select 1 from jsonb_array_elements(p_legs) x
      group by lower(x ->> 'gameId')
      having bool_or(app.is_prop(x ->> 'market'))
         and (bool_or(not app.is_prop(x ->> 'market')) or count(*) > coalesce((v_props ->> 'maxPerGame')::int, 1))
    ) then
      raise exception 'same_game_props';
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_legs) x
      where app.is_prop(x ->> 'market')
      group by lower(x ->> 'gameId'), x ->> 'player'
      having count(*) > 1
    ) then
      raise exception 'same_player';
    end if;
    -- At most props.maxPerParlay props on one slip (rule sets from before it have no such limit).
    if jsonb_typeof(v_props -> 'maxPerParlay') = 'number'
       and (select count(*) from jsonb_array_elements(p_legs) x where app.is_prop(x ->> 'market')) > (v_props ->> 'maxPerParlay')::int then
      raise exception 'too_many_props';
    end if;
    select pulled_at into v_props_pulled from public.prop_imports where ok order by at desc limit 1;
  end if;

  if p_stake_cents > app.available_cents(p_entry) then raise exception 'insufficient_units'; end if;
  if p_potential_payout_cents is null or p_potential_payout_cents <= p_stake_cents then raise exception 'bad_quote'; end if;

  -- An entry can't back both teams in one game (by spread or moneyline, in any mix), or
  -- both the over and the under (of the total, or of a player's prop), across its bets.
  if not coalesce((v_doc -> 'acrossBets' ->> 'oppositeSides')::boolean, false)
     and exists (select 1 from app.opposite_side_legs(p_entry, p_user, p_legs)) then
    raise exception 'opposite_side';
  end if;

  v_now := clock_timestamp();
  if v_doc ->> 'lock' = 'week_first_kickoff' then
    select min(least(kickoff_at, feed_commence)) into v_week_first from public.games where week = v_week.week and status <> 'void';
    if v_week_first <= v_now then raise exception 'week_locked'; end if;
  end if;

  select max(at) into v_last_pull from public.line_pulls where kind = 'lines' and ok;

  -- Lock the slip's games in id order, as the line pulls do, so the two can't deadlock.
  perform 1 from public.games where id in (select (x ->> 'gameId')::uuid from jsonb_array_elements(p_legs) x) order by id for share;

  insert into public.slips (entry_id, league_id, placed_by, week, type, teaser_points, stake_cents, quoted_american,
                            potential_payout_cents, leg_count, rule_set_version, placed_at, client_ref)
  values (p_entry, v_league, p_user, v_week.week, p_type, p_teaser_points, p_stake_cents, p_quoted_american,
          p_potential_payout_cents, v_n, v_week.rule_set_version, v_now, p_client_ref)
  returning id into v_slip;

  for v_leg in select * from jsonb_array_elements(p_legs) loop
    v_i := v_i + 1;
    select * into v_game from public.games where id = (v_leg ->> 'gameId')::uuid for share;
    if not found then raise exception 'unknown_game'; end if;
    if v_game.week <> v_week.week then raise exception 'game_not_this_week'; end if;
    v_now := clock_timestamp();
    if v_game.status <> 'scheduled' or least(v_game.kickoff_at, v_game.feed_commence) <= v_now then raise exception 'game_started'; end if;

    if app.is_prop(v_leg ->> 'market') then
      if not (v_props -> 'markets') @> to_jsonb(v_leg ->> 'market') then raise exception 'bad_market'; end if;
      select * into v_prop from public.current_props cp
       where cp.game_id = v_game.id and cp.market = v_leg ->> 'market' and cp.player = v_leg ->> 'player' and cp.side = v_leg ->> 'side';
      if not found then raise exception 'line_unavailable'; end if;
      if v_props_pulled is null or v_props_pulled < v_now - make_interval(mins => v_settings.prop_max_age_minutes) then
        raise exception 'props_stale';
      end if;
      -- Teams name their inactive players 90 minutes before kickoff, and prop lines move
      -- on it. From then on a game's props can only be bet on lines pulled after that.
      if v_now >= least(v_game.kickoff_at, v_game.feed_commence) - interval '90 minutes'
         and v_props_pulled < least(v_game.kickoff_at, v_game.feed_commence) - interval '90 minutes' then
        raise exception 'props_inactives';
      end if;
      -- Props pay the book's price, whatever the league's pricing rule for spreads and totals.
      if v_prop.point is distinct from (v_leg ->> 'point')::numeric or v_prop.price <> (v_leg ->> 'price')::int then
        raise exception 'line_moved';
      end if;
      insert into public.slip_legs (slip_id, leg_no, game_id, market, side, point, price, teased_point, book, player)
      values (v_slip, v_i, v_game.id, v_prop.market, v_prop.side, v_prop.point, v_prop.price, null, v_prop.source, v_prop.player);
      continue;
    end if;

    if v_leg ->> 'player' is not null then raise exception 'bad_market'; end if;
    if p_type = 'teaser' and v_leg ->> 'market' not in ('spread', 'total') then raise exception 'bad_market'; end if;
    if not (v_doc -> 'betTypes' -> p_type -> 'markets') @> to_jsonb(v_leg ->> 'market') then raise exception 'bad_market'; end if;

    select * into v_line from public.current_lines cl
     where cl.game_id = v_game.id and cl.market = v_leg ->> 'market' and cl.side = v_leg ->> 'side';
    if not found then raise exception 'line_unavailable'; end if;
    if not v_line.is_override and (v_last_pull is null or v_last_pull < v_now - make_interval(mins => v_settings.max_line_age_minutes)) then
      raise exception 'lines_stale';
    end if;

    v_price := case
      when p_type <> 'teaser' and v_doc -> 'pricing' ->> 'straight' = 'flat' and v_line.market <> 'moneyline'
        then (v_doc -> 'pricing' ->> 'flatPrice')::int
      else v_line.price
    end;
    if v_line.point is distinct from (v_leg ->> 'point')::numeric then raise exception 'line_moved'; end if;
    if p_type <> 'teaser' and v_price <> (v_leg ->> 'price')::int then raise exception 'line_moved'; end if;

    v_teased := case
      when p_type <> 'teaser' then null
      when v_line.market = 'spread' then v_line.point + p_teaser_points
      when v_line.side = 'over' then v_line.point - p_teaser_points
      else v_line.point + p_teaser_points
    end;

    insert into public.slip_legs (slip_id, leg_no, game_id, market, side, point, price, teased_point, book)
    values (v_slip, v_i, v_game.id, v_line.market, v_line.side, v_line.point, v_price, v_teased, v_line.source);
  end loop;

  insert into public.ledger (entry_id, amount_cents, kind, slip_id, week, created_by)
  values (p_entry, -p_stake_cents, 'stake', v_slip, v_week.week, p_user);
  return v_slip;
end $$;

-- ---------------------------------------------------------------- undo

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
  -- Prop lines change only when the owner's pulls come in, so an undo can't be checked
  -- against a fresh prop line: a bet with a player prop is final once placed.
  if exists (select 1 from public.slip_legs l where l.slip_id = v.id and l.player is not null) then
    raise exception 'undo_props';
  end if;
  v_now := clock_timestamp();
  select document into v_doc from public.rule_sets where version = v.rule_set_version;
  if v_now > v.placed_at + make_interval(secs => coalesce((v_doc ->> 'undoMinutes')::numeric, 0) * 60) then raise exception 'undo_window_passed'; end if;
  if app.slip_locks_at(v.id) <= v_now then raise exception 'game_started'; end if;
  v_checked := not coalesce((v_doc ->> 'undoAfterLineMove')::boolean, false);
  -- (A bet with a prop was refused above, so every leg from here on is a game line.)
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

-- ---------------------------------------------------------------- rules

create or replace function public.publish_rule_set_internal(
  p_actor uuid, p_league uuid, p_document jsonb, p_effective_week int, p_note text
) returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_version int; v_open int; v_path text;
begin
  if p_league is null or not app.is_commissioner(p_league, p_actor) then
    raise exception 'commissioner_only' using errcode = '42501';
  end if;
  -- Same lock as opening the league's week, so a week can't open with rules published a moment later.
  perform pg_advisory_xact_lock(hashtext('advance_week:' || p_league::text));
  v_open := app.open_week_of(p_league);
  if p_effective_week is null or p_effective_week <= coalesce(v_open, 0) then raise exception 'effective_week_must_be_future'; end if;
  if not exists (select 1 from public.weeks where week = p_effective_week) then raise exception 'unknown_week'; end if;
  if p_effective_week < (select max(effective_week) from public.rule_sets where league_id = p_league) then
    raise exception 'effective_week_before_scheduled';
  end if;
  foreach v_path in array array[
    '{weeklyMinimum,pct}', '{undoMinutes}', '{stake,minUnits}', '{stake,maxUnits}', '{stake,incrementUnits}',
    '{betTypes,parlay,minLegs}', '{betTypes,parlay,maxLegs}', '{betTypes,teaser,minLegs}', '{betTypes,teaser,maxLegs}',
    '{pricing,flatPrice}'
  ] loop
    if jsonb_typeof(p_document #> v_path::text[]) is distinct from 'number' then raise exception 'bad_rules'; end if;
  end loop;
  foreach v_path in array array[
    '{betTypes,straight,markets}', '{betTypes,parlay,markets}', '{betTypes,teaser,markets}', '{betTypes,teaser,points}'
  ] loop
    if jsonb_typeof(p_document #> v_path::text[]) is distinct from 'array' then raise exception 'bad_rules'; end if;
  end loop;
  if exists (select 1 from jsonb_array_elements(p_document #> '{betTypes,teaser,points}') x where jsonb_typeof(x) <> 'number') then
    raise exception 'bad_rules';
  end if;
  foreach v_path in array array['{undoAfterLineMove}', '{acrossBets,oppositeSides}'] loop
    if jsonb_typeof(p_document #> v_path::text[]) is distinct from 'boolean' then raise exception 'bad_rules'; end if;
  end loop;
  -- Props are optional (no section, no props); a section placing relies on must be whole.
  if p_document ? 'props' and (
       jsonb_typeof(p_document #> '{props,enabled}') is distinct from 'boolean'
    or jsonb_typeof(p_document #> '{props,markets}') is distinct from 'array'
    or jsonb_typeof(p_document #> '{props,maxPerGame}') is distinct from 'number'
    or jsonb_typeof(p_document #> '{props,maxStakePct}') is distinct from 'number'
    or (p_document #>> '{props,maxStakePct}')::numeric not between 0.01 and 100
    or (p_document #>> '{props,maxPerGame}')::numeric not in (1, 2, 3)
    or case when p_document #> '{props,maxPerParlay}' is null then false
            when jsonb_typeof(p_document #> '{props,maxPerParlay}') <> 'number' then true
            else (p_document #>> '{props,maxPerParlay}')::numeric not in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10) end
    or exists (select 1 from jsonb_array_elements(p_document #> '{props,markets}') m
               where jsonb_typeof(m) <> 'string' or not app.is_prop(m #>> '{}'))
  ) then
    raise exception 'bad_rules';
  end if;
  perform pg_advisory_xact_lock(hashtext('rule_set_version'));
  select coalesce(max(version), 0) + 1 into v_version from public.rule_sets;
  insert into public.rule_sets (version, league_id, effective_week, document, note, created_by)
  values (v_version, p_league, p_effective_week, p_document, coalesce(p_note, ''), p_actor);
  perform app.audit(p_actor, 'rules_published', 'rule_set', v_version::text, null,
    jsonb_build_object('version', v_version, 'effectiveWeek', p_effective_week, 'document', p_document), p_note, p_league);
  return v_version;
end $$;

-- New leagues start from rule set 1, so it gets the safer props defaults the day-one
-- rules now carry (still off). It's the template no league plays under, so nothing
-- changes for anyone's bets; existing leagues keep their own rules.
alter table public.rule_sets disable trigger rule_sets_append_only;
update public.rule_sets
   set document = jsonb_set(document, '{props}', (document -> 'props') || '{"maxPerGame": 1, "maxStakePct": 2, "maxPerParlay": 3}'::jsonb)
 where version = 1 and league_id is null and document ? 'props';
alter table public.rule_sets enable trigger rule_sets_append_only;

-- ---------------------------------------------------------------- box scores

create or replace function public.games_needing_boxes_internal()
returns table (game_id uuid, kickoff_at timestamptz, home_name text, away_name text)
language sql stable security definer set search_path = public, pg_temp
as $$
  select g.id, g.kickoff_at, th.name, ta.name
  from public.games g
  join public.teams th on th.abbr = g.home_team
  join public.teams ta on ta.abbr = g.away_team
  where g.status = 'final'
    and not exists (select 1 from public.game_boxes b where b.game_id = g.id and b.source <> 'admin')
    and exists (select 1 from public.slip_legs l join public.slips s on s.id = l.slip_id
                where l.game_id = g.id and l.player is not null and s.status = 'pending')
  order by g.kickoff_at
$$;

drop function public.ingest_box_internal(uuid, text, jsonb);

create or replace function public.ingest_box_internal(p_game uuid, p_espn_id text, p_players jsonb, p_source text default 'espn') returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_n int;
begin
  perform 1 from public.games where id = p_game and status = 'final' for share;
  if not found then raise exception 'game_not_final'; end if;
  if jsonb_typeof(p_players) is distinct from 'array' then raise exception 'bad_players'; end if;
  if p_source is null or p_source not in ('espn', 'feed') then raise exception 'bad_source'; end if;
  -- A row an admin's stats made under the old rule isn't a box score.
  delete from public.game_boxes where game_id = p_game and source = 'admin';
  insert into public.game_boxes (game_id, espn_id, source) values (p_game, p_espn_id, p_source)
  on conflict (game_id) do nothing;
  if not found then return 0; end if;
  insert into public.player_stats (game_id, player, team, source, pass_yds, rush_yds, rec_yds, receptions, tds)
  select p_game, left(trim(x ->> 'player'), 80), x ->> 'team', 'espn',
         coalesce((x ->> 'passYds')::int, 0), coalesce((x ->> 'rushYds')::int, 0), coalesce((x ->> 'recYds')::int, 0),
         greatest(coalesce((x ->> 'receptions')::int, 0), 0), greatest(coalesce((x ->> 'tds')::int, 0), 0)
  from jsonb_array_elements(p_players) x
  where length(trim(coalesce(x ->> 'player', ''))) between 1 and 80;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ---------------------------------------------------------------- an admin's stats

create or replace function public.admin_set_player_stats(
  p_game uuid, p_player text, p_played boolean, p_pass_yds int, p_rush_yds int, p_rec_yds int,
  p_receptions int, p_tds int, p_reason text
) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_actor uuid := app.require_admin();
  v_reason text := app.require_reason(p_reason);
  g public.games%rowtype;
  v_player text := trim(coalesce(p_player, ''));
  v_reopened int;
  v_before jsonb;
begin
  select * into g from public.games where id = p_game for update;
  if not found then raise exception 'not_found'; end if;
  if g.status <> 'final' then raise exception 'game_not_final'; end if;
  if length(v_player) not between 1 and 80 then raise exception 'bad_player'; end if;
  if p_played is null or (p_played and (p_pass_yds is null or p_rush_yds is null or p_rec_yds is null
       or p_receptions is null or p_tds is null or p_receptions < 0 or p_tds < 0)) then
    raise exception 'bad_stats';
  end if;
  select to_jsonb(s) - 'id' - 'game_id' into v_before from public.player_stats s
   where s.game_id = p_game and s.source = 'admin' and lower(s.player) = lower(v_player);
  delete from public.player_stats where game_id = p_game and source = 'admin' and lower(player) = lower(v_player);
  insert into public.player_stats (game_id, player, source, played, pass_yds, rush_yds, rec_yds, receptions, tds, set_by, reason)
  values (p_game, v_player, 'admin', p_played,
          case when p_played then p_pass_yds else 0 end, case when p_played then p_rush_yds else 0 end,
          case when p_played then p_rec_yds else 0 end, case when p_played then p_receptions else 0 end,
          case when p_played then p_tds else 0 end, v_actor, v_reason);
  -- His bets stop waiting on an admin, in every league. (His row grades his props only: the rest of the
  -- game's props still wait for the box score, from ESPN or the owner's PC.)
  delete from public.prop_holds h where h.game_id = p_game and lower(h.player) = lower(v_player);
  v_reopened := app.reopen_graded(p_game, v_actor, v_reason);
  update public.games set updated_at = clock_timestamp() where id = p_game;
  perform app.audit(v_actor, 'player_stats_set', 'game', p_game::text, v_before,
    jsonb_build_object('player', v_player, 'played', p_played, 'passYds', p_pass_yds, 'rushYds', p_rush_yds,
                       'recYds', p_rec_yds, 'receptions', p_receptions, 'tds', p_tds, 'betsRegraded', v_reopened),
    v_reason);
end $$;

-- ---------------------------------------------------------------- holds

-- Replaces the list of held props with the grader's latest (p_holds: [{gameId, player,
-- why, candidate, bets}]), keeping when each one started waiting.
create or replace function public.record_prop_holds_internal(p_holds jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if jsonb_typeof(p_holds) is distinct from 'array' then raise exception 'bad_holds'; end if;
  delete from public.prop_holds h
   where not exists (select 1 from jsonb_array_elements(p_holds) x
                     where jsonb_typeof(x) = 'object' and x ->> 'gameId' = h.game_id::text and x ->> 'player' = h.player);
  insert into public.prop_holds (game_id, player, why, candidate, bets)
  select distinct on (g.id, x ->> 'player') g.id, x ->> 'player', x ->> 'why',
         case when jsonb_typeof(x -> 'candidate') = 'object' then x -> 'candidate' end,
         greatest(coalesce((x ->> 'bets')::int, 0), 0)
  from jsonb_array_elements(p_holds) x
  join public.games g on g.id::text = x ->> 'gameId'
  where jsonb_typeof(x) = 'object'
    and length(x ->> 'player') between 1 and 80
    and x ->> 'why' in ('missing', 'ambiguous', 'name', 'no_box')
  on conflict (game_id, player) do update set why = excluded.why, candidate = excluded.candidate, bets = excluded.bets;
end $$;

-- The held props, for the site admins' list (Admin > Site feeds). They're shared by
-- every league, like the games and box scores.
create or replace function public.admin_prop_holds()
returns table (game_id uuid, label text, kickoff_at timestamptz, player text, why text, candidate jsonb, bets int, since timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  perform app.require_admin();
  return query
    select h.game_id, format('%s at %s', ta.short_name, th.short_name), g.kickoff_at, h.player, h.why, h.candidate, h.bets, h.since
    from public.prop_holds h
    join public.games g on g.id = h.game_id
    join public.teams th on th.abbr = g.home_team
    join public.teams ta on ta.abbr = g.away_team
    order by g.kickoff_at, h.player;
end $$;

-- ---------------------------------------------------------------- ruled out

-- Players whose props came off the board once inactives were announced: in no import
-- pulled in the 90 minutes before the game locked, while the game's other props were
-- still there. The books take a player's props down when he's ruled out, so one of
-- these who's missing from the box score didn't play.
create or replace function public.props_left_board_internal(p_games uuid[])
returns table (game_id uuid, player text)
language sql stable security definer set search_path = public, pg_temp
as $$
  with g as (
    select id, least(kickoff_at, feed_commence) as locks from public.games where id = any(p_games)
  ),
  first_after as (
    -- The first import pulled after inactives that still had some of the game's props.
    select g.id, min(pi.at) as at
    from g
    join public.prop_imports pi on pi.ok and pi.pulled_at >= g.locks - interval '90 minutes' and pi.at < g.locks
    where exists (select 1 from public.prop_lines pl where pl.game_id = g.id and pl.seen_at >= pi.at)
    group by g.id
  )
  select pl.game_id, pl.player
  from public.prop_lines pl
  join first_after f on f.id = pl.game_id
  group by pl.game_id, pl.player
  having max(pl.seen_at) < min(f.at)
$$;

-- ---------------------------------------------------------------- the owner's key

-- Whether a key is the one the owner's PC presents (import-boxes checks it the way
-- ingest_props_internal does).
create or replace function public.prop_key_ok_internal(p_key text) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(p_key, '') <> ''
     and exists (select 1 from app.prop_import_key k where k.sha256 = encode(sha256(convert_to(p_key, 'UTF8')), 'hex'))
$$;

-- ---------------------------------------------------------------- access

revoke execute on function public.ingest_box_internal(uuid, text, jsonb, text) from public, anon, authenticated;
revoke execute on function public.record_prop_holds_internal(jsonb) from public, anon, authenticated;
revoke execute on function public.props_left_board_internal(uuid[]) from public, anon, authenticated;
revoke execute on function public.prop_key_ok_internal(text) from public, anon, authenticated;
revoke execute on function public.admin_prop_holds() from public, anon;
grant execute on function public.admin_prop_holds() to authenticated;
grant execute on all functions in schema public to service_role;
grant execute on all functions in schema app to service_role;
