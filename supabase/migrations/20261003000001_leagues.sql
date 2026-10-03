-- Many leagues on one site.
--
-- Shared by every league: the NFL calendar (weeks' windows), teams, games, lines,
-- scores and the Odds API pulls, so one pull serves every league and more leagues cost
-- no more credits. These are run by the site admins (profiles.is_admin): line
-- overrides, game status, score corrections and moving a game between weeks.
--
-- Per league: its members and commissioners, entries, rule-set versions, which week is
-- open, the weekly minimum, banks, bets, standings and the admin log. Members see only
-- the leagues they belong to. Commissioners run their own league with the powers the
-- single-league site gave its admins, under the same guards (no peeking at hidden bets).
--
-- Anyone signed in can start a league; it starts on the day-one rules (rule set 1's
-- document). Others join with the league's invite code.
--
-- Functions that act on one league take p_league. Where it's the last argument it may
-- be left null: it then means the one league the caller commissions (admin functions)
-- or belongs to (member functions), and is refused as league_required if there are
-- none or several.
--
-- A database that already holds a league from the single-league site gets it as its
-- first league, with nothing lost; a new database starts with no leagues.

-- ---------------------------------------------------------------- tables

create or replace function app.new_invite_code() returns text
language sql volatile
as $$
  -- 10 characters from 32 that can't be mistaken for each other: 50 bits, too many to guess.
  select string_agg(substr('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 1 + floor(random() * 32)::int, 1), '')
  from generate_series(1, 10)
$$;
revoke execute on function app.new_invite_code() from public, anon, authenticated;

create table public.leagues (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 60),
  invite_code text not null unique default app.new_invite_code(),
  -- Whether someone joining with the invite code gets an entry of their own, with the
  -- starting bank of the league's rules. Off, the commissioner adds entries.
  self_entry boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.league_members (
  league_id uuid not null references public.leagues (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null default 'member' check (role in ('commissioner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (league_id, user_id)
);
create index on public.league_members (user_id);

-- Each league's progress through the shared calendar. Replaces weeks.status and the
-- columns that went with it.
create table public.league_weeks (
  league_id uuid not null references public.leagues (id) on delete cascade,
  week int not null references public.weeks (week),
  status text not null default 'upcoming' check (status in ('upcoming', 'open', 'closed')),
  opened_at timestamptz,
  opened_by uuid references public.profiles (id),
  closed_at timestamptz,
  rule_set_version int references public.rule_sets (version),
  primary key (league_id, week),
  check (status <> 'open' or rule_set_version is not null)
);
-- At most one week is open for betting in each league.
create unique index league_weeks_one_open on public.league_weeks (league_id) where status = 'open';
create index on public.league_weeks (week, status);

alter table public.entries add column league_id uuid references public.leagues (id);
-- Rule set 1 is the day-one template every new league copies; it belongs to no league
-- unless a single-league site's data comes over below.
alter table public.rule_sets add column league_id uuid references public.leagues (id);
alter table public.slips add column league_id uuid references public.leagues (id);
-- Null for site-wide actions (a score, a line), readable by everyone signed in.
alter table public.audit_log add column league_id uuid references public.leagues (id);
create index on public.audit_log (league_id, created_at desc);

-- ---------------------------------------------------------------- existing league

do $$
declare v_league uuid;
begin
  if exists (select 1 from public.entries)
     or exists (select 1 from public.weeks where status <> 'upcoming')
     or exists (select 1 from public.rule_sets where version > 1) then
    insert into public.leagues (name, created_by)
    values ((select league_name from public.league_settings), null)
    returning id into v_league;
    insert into public.league_members (league_id, user_id, role)
    select v_league, p.id, case when p.is_admin then 'commissioner' else 'member' end
    from public.profiles p
    where p.is_admin or exists (select 1 from public.entry_managers m where m.user_id = p.id);
    update public.entries set league_id = v_league;
    update public.slips set league_id = v_league;
    -- Append-only tables, opened for this one backfill.
    alter table public.rule_sets disable trigger rule_sets_append_only;
    alter table public.audit_log disable trigger audit_append_only;
    update public.rule_sets set league_id = v_league;
    update public.audit_log set league_id = v_league;
    alter table public.rule_sets enable trigger rule_sets_append_only;
    alter table public.audit_log enable trigger audit_append_only;
    insert into public.league_weeks (league_id, week, status, opened_at, opened_by, closed_at, rule_set_version)
    select v_league, week, status, opened_at, opened_by, closed_at, rule_set_version from public.weeks;
  end if;
end $$;

alter table public.entries alter column league_id set not null;
alter table public.slips alter column league_id set not null;
create index on public.entries (league_id);
create index on public.slips (league_id, week, status);
alter table public.entries drop constraint entries_name_key;
alter table public.entries add constraint entries_league_name_key unique (league_id, name);

drop trigger weeks_guard on public.weeks;
drop function app.weeks_guard();
drop index public.weeks_one_open;
alter table public.weeks
  drop column status, drop column opened_at, drop column opened_by, drop column closed_at, drop column rule_set_version;

-- The league's name lives on the league now; league_settings holds the site's pull settings.
alter table public.league_settings drop column league_name;

-- ---------------------------------------------------------------- helpers

create or replace function app.is_member(p_league uuid, p_user uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select p_user is not null
     and exists (select 1 from public.league_members where league_id = p_league and user_id = p_user)
$$;

create or replace function app.is_commissioner(p_league uuid, p_user uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select p_user is not null
     and exists (select 1 from public.league_members where league_id = p_league and user_id = p_user and role = 'commissioner')
$$;

create or replace function app.entry_league(p_entry uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp
as $$ select league_id from public.entries where id = p_entry $$;

-- The league a call is about: p_league if given, else the one league the caller
-- commissions (p_commissioner) or belongs to.
create or replace function app.resolve_league(p_league uuid, p_commissioner boolean) returns uuid
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v uuid[];
begin
  if p_league is not null then return p_league; end if;
  select array_agg(league_id) into v from public.league_members
   where user_id = auth.uid() and (not p_commissioner or role = 'commissioner');
  if p_commissioner and v is null then raise exception 'commissioner_only' using errcode = '42501'; end if;
  if v is null then raise exception 'not_member' using errcode = '42501'; end if;
  if array_length(v, 1) > 1 then raise exception 'league_required'; end if;
  return v[1];
end $$;

-- The caller, if they're a commissioner of the league; refuses everyone else, site
-- admins included (they run the shared games and lines, not other people's leagues).
create or replace function app.require_commissioner(p_league uuid) returns uuid
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v uuid := auth.uid();
begin
  if v is null or p_league is null or not app.is_commissioner(p_league, v) then
    raise exception 'commissioner_only' using errcode = '42501';
  end if;
  return v;
end $$;

create or replace function app.open_week_of(p_league uuid) returns int
language sql stable security definer set search_path = public, pg_temp
as $$ select week from public.league_weeks where league_id = p_league and status = 'open' $$;

drop function app.audit(uuid, text, text, text, jsonb, jsonb, text);
create or replace function app.audit(
  p_actor uuid, p_action text, p_target_type text, p_target_id text, p_before jsonb, p_after jsonb, p_reason text,
  p_league uuid default null
) returns void
language sql security definer set search_path = public, pg_temp
as $$
  insert into public.audit_log (actor, action, target_type, target_id, before, after, reason, league_id)
  values (p_actor, p_action, p_target_type, p_target_id, p_before, p_after, coalesce(p_reason, ''), p_league)
$$;

drop function app.rule_set_for_week(int);
create or replace function app.rule_set_for_week(p_league uuid, p_week int) returns int
language sql stable security definer set search_path = public, pg_temp
as $$
  select version from public.rule_sets where league_id = p_league and effective_week <= p_week
  order by effective_week desc, version desc limit 1
$$;

-- Bets: whoever placed it and the entry's managers as of then; the rest of its league
-- once it's revealed. Nobody outside the league, ever.
create or replace function app.can_see_slip(p_slip uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.slips s
    where s.id = p_slip
      and (s.placed_by = auth.uid() or app.managed_at(s.entry_id, s.placed_at)
           or (s.status <> 'undone' and app.is_member(s.league_id) and app.slip_reveal_at(s.id) <= now()))
  )
$$;

create or replace function app.can_see_leg(p_slip uuid, p_game uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.slips s
    join public.games g on g.id = p_game
    where s.id = p_slip
      and (s.placed_by = auth.uid() or app.managed_at(s.entry_id, s.placed_at)
           or (app.is_member(s.league_id) and app.leg_public(s.id, g.id)))
  )
$$;

-- ---------------------------------------------------------------- bets

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
  v_settings public.league_settings%rowtype;
  v_last_pull timestamptz;
  v_leg jsonb;
  v_game public.games%rowtype;
  v_line record;
  v_price int;
  v_slip uuid;
  v_n int;
  v_i int := 0;
  v_teased numeric;
  v_week_first timestamptz;
  v_now timestamptz;
  v_existing public.slips%rowtype;
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
                               and l.game_id::text = lower(x ->> 'gameId') and l.market = x ->> 'market' and l.side = x ->> 'side')
         )
         or exists (
           select 1 from public.slip_legs l
           where l.slip_id = v_existing.id
             and not exists (select 1 from jsonb_array_elements(p_legs) x
                             where l.game_id::text = lower(x ->> 'gameId') and l.market = x ->> 'market' and l.side = x ->> 'side')
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
  if p_stake_cents > app.available_cents(p_entry) then raise exception 'insufficient_units'; end if;
  if p_potential_payout_cents is null or p_potential_payout_cents <= p_stake_cents then raise exception 'bad_quote'; end if;

  -- An entry can't back both teams in one game (by spread or moneyline, in any mix), or
  -- both the over and the under, across its bets (see the single-league migration).
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
    if p_type = 'teaser' and v_leg ->> 'market' not in ('spread', 'total') then raise exception 'bad_market'; end if;
    if not (v_doc -> 'betTypes' -> p_type -> 'markets') @> to_jsonb(v_leg ->> 'market') then raise exception 'bad_market'; end if;

    select * into v_game from public.games where id = (v_leg ->> 'gameId')::uuid for share;
    if not found then raise exception 'unknown_game'; end if;
    if v_game.week <> v_week.week then raise exception 'game_not_this_week'; end if;
    v_now := clock_timestamp();
    if v_game.status <> 'scheduled' or least(v_game.kickoff_at, v_game.feed_commence) <= v_now then raise exception 'game_started'; end if;

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

create or replace function public.opposite_side_legs_internal(p_entry uuid, p_user uuid, p_legs jsonb) returns int[]
language sql stable security definer set search_path = public, pg_temp
as $$
  select case
      when coalesce((r.document -> 'acrossBets' ->> 'oppositeSides')::boolean, false) then '{}'::int[]
      else coalesce((select array_agg(i order by i) from app.opposite_side_legs(p_entry, p_user, p_legs) i), '{}'::int[])
    end
  from public.league_weeks w join public.rule_sets r on r.version = w.rule_set_version
  where w.league_id = app.entry_league(p_entry) and w.status = 'open'
$$;

-- The open week and its rules for the entry's league, for the place-slip Edge Function.
create or replace function public.open_week_for_entry_internal(p_entry uuid)
returns table (week int, rule_set_version int)
language sql stable security definer set search_path = public, pg_temp
as $$
  select w.week, w.rule_set_version from public.league_weeks w
  where w.league_id = app.entry_league(p_entry) and w.status = 'open'
$$;

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
  if p_check_only then return case when v_checked then v_now end; end if;
  if v_checked then
    select (select lp.fetched_after from public.line_pulls lp where lp.kind = 'lines' and lp.ok order by lp.at desc limit 1),
           exists (
             select 1
             from public.slip_legs l
             left join public.current_lines cl on cl.game_id = l.game_id and cl.market = l.market and cl.side = l.side
             where l.slip_id = v.id
               and (cl.game_id is null
                    or cl.point is distinct from l.point
                    or (cl.price <> l.price
                        and v.type <> 'teaser'
                        and not (v_doc -> 'pricing' ->> 'straight' = 'flat' and l.market <> 'moneyline')))
           )
      into v_fetched_after, v_moved;
    if p_lines_since is null or p_lines_since > v_now or p_lines_since < v_now - interval '2 minutes'
       or coalesce(v_fetched_after < p_lines_since, true) then
      raise exception 'undo_lines_stale';
    end if;
    if v_moved then raise exception 'undo_line_moved'; end if;
  end if;
  update public.slips set status = 'undone', undone_at = v_now where id = p_slip;
  insert into public.ledger (entry_id, amount_cents, kind, slip_id, week, created_by)
  values (v.entry_id, v.stake_cents, 'undo', v.id, v.week, p_user);
  return v_now;
end $$;

-- ---------------------------------------------------------------- weeks

create or replace function app.snapshot_entry(p_week int, p_entry uuid) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_doc jsonb; v_bank bigint;
begin
  select r.document into v_doc from public.league_weeks w join public.rule_sets r on r.version = w.rule_set_version
   where w.league_id = app.entry_league(p_entry) and w.week = p_week;
  v_bank := app.bank_cents(p_entry);
  insert into public.week_entry_status (week, entry_id, bank_at_start_cents, required_cents)
  values (p_week, p_entry, v_bank, app.required_cents(v_bank, v_doc))
  on conflict (week, entry_id) do update
    set bank_at_start_cents = excluded.bank_at_start_cents, required_cents = excluded.required_cents;
end $$;

drop function app.close_week(int);
create or replace function app.close_week(p_league uuid, p_week int) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_doc jsonb;
  v_deduct boolean;
  r record;
  v_wagered bigint;
  v_short bigint;
  v_ded bigint;
begin
  select rs.document into v_doc from public.league_weeks w join public.rule_sets rs on rs.version = w.rule_set_version
   where w.league_id = p_league and w.week = p_week;
  v_deduct := coalesce(v_doc -> 'weeklyMinimum' ->> 'penalty' = 'deduct_shortfall', false);
  -- Lock the week's entries, then every bet of the week, before writing any result: the
  -- order placing, undoing and corrections take them in.
  perform 1 from public.entries
   where league_id = p_league and id in (select entry_id from public.week_entry_status where week = p_week)
   order by id for no key update;
  perform 1 from public.slips where league_id = p_league and week = p_week order by id for share;
  for r in
    select wes.entry_id, wes.required_cents from public.week_entry_status wes
    join public.entries e on e.id = wes.entry_id and e.league_id = p_league
    where wes.week = p_week order by wes.entry_id
  loop
    select coalesce(sum(stake_cents), 0) into v_wagered from public.slips
     where entry_id = r.entry_id and week = p_week and app.counts_toward_minimum(status, void_reason);
    v_short := greatest(0, r.required_cents - v_wagered);
    v_ded := 0;
    if v_short > 0 and v_deduct then
      v_ded := least(v_short, greatest(0, app.available_cents(r.entry_id)));
      if v_ded > 0 then
        insert into public.ledger (entry_id, amount_cents, kind, week, note)
        values (r.entry_id, -v_ded, 'weekly_minimum', p_week,
                format('Week %s minimum: wagered %s of %s units', p_week,
                       to_char(v_wagered / 100.0, 'FM999999990.00'), to_char(r.required_cents / 100.0, 'FM999999990.00')));
      end if;
    end if;
    update public.week_entry_status
       set wagered_cents = v_wagered, shortfall_cents = v_short, deducted_cents = v_ded,
           waived_cents = case when v_deduct then v_short - v_ded else 0 end, unpaid_cents = 0
     where week = p_week and entry_id = r.entry_id;
  end loop;
  update public.league_weeks set status = 'closed', closed_at = now() where league_id = p_league and week = p_week;
end $$;

create or replace function app.recheck_minimum(p_week int, p_entry uuid) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  w public.week_entry_status%rowtype;
  v_doc jsonb;
  v_wagered bigint;
  v_short bigint;
  v_owed bigint;
  v_have bigint;
  v_unpaid bigint;
  v_delta bigint := 0;
begin
  select * into w from public.week_entry_status where week = p_week and entry_id = p_entry for update;
  if not found or w.wagered_cents is null then return; end if;
  select rs.document into v_doc from public.league_weeks wk join public.rule_sets rs on rs.version = wk.rule_set_version
   where wk.league_id = app.entry_league(p_entry) and wk.week = p_week;
  select coalesce(sum(stake_cents), 0) into v_wagered from public.slips
   where entry_id = p_entry and week = p_week and app.counts_toward_minimum(status, void_reason);
  if v_wagered = w.wagered_cents then return; end if;
  v_short := greatest(0, w.required_cents - v_wagered);
  v_unpaid := coalesce(w.unpaid_cents, 0);
  if v_doc -> 'weeklyMinimum' ->> 'penalty' = 'deduct_shortfall' then
    v_owed := greatest(0, v_short - coalesce(w.waived_cents, 0));
    v_have := coalesce(w.deducted_cents, 0) + v_unpaid;
    if v_owed > v_have then
      v_delta := -least(v_owed - v_have, greatest(0, app.available_cents(p_entry)));
      v_unpaid := v_unpaid + (v_owed - v_have) + v_delta;
    elsif v_owed < v_have then
      v_delta := greatest(0, (v_have - v_owed) - v_unpaid);
      v_unpaid := greatest(0, v_unpaid - (v_have - v_owed));
    end if;
  end if;
  if v_delta <> 0 then
    insert into public.ledger (entry_id, amount_cents, kind, week, note)
    values (p_entry, v_delta, 'weekly_minimum', p_week,
            format('Week %s minimum redone after a bet changed: wagered %s of %s units', p_week,
                   to_char(v_wagered / 100.0, 'FM999999990.00'), to_char(w.required_cents / 100.0, 'FM999999990.00')));
  end if;
  update public.week_entry_status
     set wagered_cents = v_wagered, shortfall_cents = v_short,
         deducted_cents = coalesce(w.deducted_cents, 0) - v_delta, unpaid_cents = v_unpaid
   where week = p_week and entry_id = p_entry;
end $$;

drop function app.open_week(int, uuid);
create or replace function app.open_week(p_league uuid, p_week int, p_actor uuid) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_version int; e record;
begin
  v_version := app.rule_set_for_week(p_league, p_week);
  if v_version is null then raise exception 'no_rule_set'; end if;
  update public.league_weeks set status = 'open', opened_at = now(), opened_by = p_actor, rule_set_version = v_version
   where league_id = p_league and week = p_week and status = 'upcoming';
  if not found then raise exception 'week_not_upcoming'; end if;
  for e in select id from public.entries where league_id = p_league and status = 'active' order by id loop
    perform app.snapshot_entry(p_week, e.id);
  end loop;
end $$;

-- As in the single-league site, for one league (see the first functions migration).
drop function app.advance_week(uuid, boolean, int, boolean);
create or replace function app.advance_week(
  p_league uuid, p_actor uuid, p_force boolean, p_expected_open int default null, p_end_season boolean default false
) returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_open int;
  v_next int;
begin
  perform pg_advisory_xact_lock(hashtext('advance_week:' || p_league::text));
  select week into v_open from public.league_weeks where league_id = p_league and status = 'open';
  if p_force and v_open is distinct from p_expected_open then raise exception 'week_changed'; end if;
  if p_end_season and v_open is null then raise exception 'no_open_week'; end if;
  if v_open is null then
    if not p_force then return null; end if;
    select min(w.week) into v_next from public.weeks w
    join public.league_weeks lw on lw.week = w.week and lw.league_id = p_league
     where lw.status = 'upcoming' and w.ends_at > now()
       and exists (select 1 from public.games g where g.week = w.week);
    if v_next is null then raise exception 'no_week_to_open'; end if;
    update public.league_weeks set status = 'closed', closed_at = now()
     where league_id = p_league and status = 'upcoming' and week < v_next;
  else
    if p_force and not exists (select 1 from public.games where week = v_open and kickoff_at <= clock_timestamp()) then
      raise exception 'week_not_started';
    end if;
    select min(lw.week) into v_next from public.league_weeks lw
     where lw.league_id = p_league and lw.week > v_open and lw.status = 'upcoming'
       and exists (select 1 from public.games g where g.week = lw.week);
    if p_force and v_next is null and not p_end_season then raise exception 'next_week_not_loaded'; end if;
    if p_force and v_next is not null and p_end_season then raise exception 'next_week_loaded'; end if;
    if not p_force and (
         v_next is null
      or exists (select 1 from public.games where week = v_open and status not in ('final', 'void'))
      or exists (select 1 from public.slips where league_id = p_league and week = v_open and status = 'pending')) then
      return null;
    end if;
    perform app.close_week(p_league, v_open);
    if v_next is null then
      perform app.audit(p_actor, 'week_closed', 'week', v_open::text, null, jsonb_build_object('closed', v_open),
        'Closed by an admin: the end of the season', p_league);
      return null;
    end if;
  end if;
  perform app.open_week(p_league, v_next, p_actor);
  perform app.audit(p_actor, 'week_opened', 'week', v_next::text,
    case when v_open is null then null else jsonb_build_object('closed', v_open) end,
    jsonb_build_object('opened', v_next),
    case when p_force then 'Opened by an admin' else 'The previous week finished' end, p_league);
  return v_next;
end $$;

-- The scheduled job: every league whose open week is done moves on. Returns the latest
-- week any league opened, or null. One league's failure doesn't hold up the others.
create or replace function public.advance_week_internal() returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare l record; v int; v_max int;
begin
  for l in select id from public.leagues order by created_at, id loop
    begin
      v := app.advance_week(l.id, null, false);
      if v is not null then v_max := greatest(coalesce(v_max, v), v); end if;
    exception when others then
      raise warning 'advance week for league %: %', l.id, sqlerrm;
    end;
  end loop;
  return v_max;
end $$;

-- ---------------------------------------------------------------- rules

drop function public.publish_rule_set_internal(uuid, jsonb, int, text);
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
  perform pg_advisory_xact_lock(hashtext('rule_set_version'));
  select coalesce(max(version), 0) + 1 into v_version from public.rule_sets;
  insert into public.rule_sets (version, league_id, effective_week, document, note, created_by)
  values (v_version, p_league, p_effective_week, p_document, coalesce(p_note, ''), p_actor);
  perform app.audit(p_actor, 'rules_published', 'rule_set', v_version::text, null,
    jsonb_build_object('version', v_version, 'effectiveWeek', p_effective_week, 'document', p_document), p_note, p_league);
  return v_version;
end $$;

create or replace function app.rule_sets_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v int;
begin
  if new.league_id is null then return new; end if;
  v := app.open_week_of(new.league_id);
  if v is not null and new.effective_week <= v then
    raise exception 'rules can only change from a future week';
  end if;
  return new;
end $$;

create or replace function app.league_weeks_guard() returns trigger
language plpgsql
as $$
begin
  if old.status <> 'upcoming' and new.rule_set_version is distinct from old.rule_set_version then
    raise exception 'a week''s rules are fixed once it opens';
  end if;
  if old.status = 'closed' and new.status <> 'closed' then
    raise exception 'a closed week stays closed';
  end if;
  if (new.league_id, new.week) is distinct from (old.league_id, old.week) then
    raise exception 'a league week cannot move';
  end if;
  return new;
end $$;
create trigger league_weeks_guard before update on public.league_weeks
for each row execute function app.league_weeks_guard();

create or replace function app.slips_guard() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then raise exception 'slips cannot be deleted'; end if;
  if (new.entry_id, new.league_id, new.placed_by, new.week, new.type, new.teaser_points, new.stake_cents, new.quoted_american,
      new.potential_payout_cents, new.leg_count, new.rule_set_version, new.placed_at, new.client_ref)
     is distinct from
     (old.entry_id, old.league_id, old.placed_by, old.week, old.type, old.teaser_points, old.stake_cents, old.quoted_american,
      old.potential_payout_cents, old.leg_count, old.rule_set_version, old.placed_at, old.client_ref) then
    raise exception 'a placed slip cannot be changed';
  end if;
  if new.status = 'pending' and old.status <> 'pending' then
    if current_setting('app.reopening', true) = 'on' and old.status in ('won', 'lost', 'push', 'void') and old.void_reason is null then
      return new;
    end if;
    raise exception 'a settled slip can only be voided';
  end if;
  if old.status in ('void', 'undone') and new.status <> old.status then
    raise exception 'a voided or undone slip cannot change';
  end if;
  if old.status in ('won', 'lost', 'push') and new.status <> old.status and new.status <> 'void' then
    raise exception 'a settled slip can only be voided';
  end if;
  return new;
end $$;

-- An entry stays in its league.
create or replace function app.entries_guard() returns trigger
language plpgsql
as $$
begin
  if new.league_id is distinct from old.league_id then raise exception 'an entry cannot change league'; end if;
  return new;
end $$;
create trigger entries_guard before update on public.entries
for each row execute function app.entries_guard();

-- ---------------------------------------------------------------- leagues

-- Starts a league with the caller as its commissioner, on the day-one rules (rule set
-- 1's document) from week 1. Returns its id. A person can start at most 10 leagues.
create or replace function public.create_league(p_name text) returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_actor uuid := auth.uid(); v_id uuid; v_version int;
begin
  if v_actor is null then raise exception 'sign_in_required'; end if;
  if p_name is null or length(trim(p_name)) not between 1 and 60 then raise exception 'bad_name'; end if;
  if (select count(*) from public.leagues where created_by = v_actor) >= 10 then raise exception 'too_many_leagues'; end if;
  insert into public.leagues (name, created_by) values (trim(p_name), v_actor) returning id into v_id;
  insert into public.league_members (league_id, user_id, role) values (v_id, v_actor, 'commissioner');
  insert into public.league_weeks (league_id, week) select v_id, week from public.weeks;
  perform pg_advisory_xact_lock(hashtext('rule_set_version'));
  select coalesce(max(version), 0) + 1 into v_version from public.rule_sets;
  insert into public.rule_sets (version, league_id, effective_week, document, note, created_by)
  select v_version, v_id, 1, document, 'Starting rules', v_actor from public.rule_sets where version = 1;
  perform app.audit(v_actor, 'league_created', 'league', v_id::text, null, jsonb_build_object('name', trim(p_name)), null, v_id);
  return v_id;
end $$;

-- What an invite code leads to, so the site can ask "Join X?" first.
create or replace function public.league_by_invite(p_code text)
returns table (league_id uuid, name text, members int, already_member boolean, self_entry boolean)
language sql stable security definer set search_path = public, pg_temp
as $$
  select l.id, l.name, (select count(*)::int from public.league_members m where m.league_id = l.id),
         app.is_member(l.id), l.self_entry
  from public.leagues l
  where auth.uid() is not null and l.invite_code = upper(trim(p_code))
$$;

-- Joins a league by its invite code. With an entry name, and if the league lets members
-- make their own entry, also adds an entry with the starting bank of the league's
-- current rules, managed by the caller. Returns the league's id.
create or replace function public.join_league(p_code text, p_entry_name text default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  l public.leagues%rowtype;
  v_entry uuid;
  v_week int;
  v_doc jsonb;
  v_bank bigint;
begin
  if v_actor is null then raise exception 'sign_in_required'; end if;
  select * into l from public.leagues where invite_code = upper(trim(p_code));
  if not found then raise exception 'bad_invite'; end if;
  if not app.is_member(l.id, v_actor) then
    insert into public.league_members (league_id, user_id) values (l.id, v_actor);
    perform app.audit(v_actor, 'member_joined', 'profile', v_actor::text, null,
      jsonb_build_object('member', (select display_name from public.profiles where id = v_actor)), null, l.id);
  end if;
  if nullif(trim(p_entry_name), '') is not null then
    if not l.self_entry then raise exception 'self_entry_off'; end if;
    if exists (select 1 from public.entry_managers m join public.entries e on e.id = m.entry_id
               where e.league_id = l.id and m.user_id = v_actor) then
      raise exception 'already_has_entry';
    end if;
    perform pg_advisory_xact_lock(hashtext('advance_week:' || l.id::text));
    v_week := app.open_week_of(l.id);
    select document into v_doc from public.rule_sets
     where version = app.rule_set_for_week(l.id, coalesce(v_week, (select max(effective_week) from public.rule_sets where league_id = l.id)));
    v_bank := round(coalesce((v_doc -> 'bank' ->> 'startUnits')::numeric, 0) * 100)::bigint;
    insert into public.entries (league_id, name, starting_bank_cents) values (l.id, trim(p_entry_name), v_bank) returning id into v_entry;
    if v_bank > 0 then
      insert into public.ledger (entry_id, amount_cents, kind, note, created_by) values (v_entry, v_bank, 'opening', 'Starting bank', v_actor);
    end if;
    insert into public.entry_managers (entry_id, user_id) values (v_entry, v_actor);
    if v_week is not null then perform app.snapshot_entry(v_week, v_entry); end if;
    perform app.audit(v_actor, 'entry_added', 'entry', v_entry::text, null,
      jsonb_build_object('name', trim(p_entry_name), 'startingBankCents', v_bank), 'Joined with the invite link', l.id);
  end if;
  return l.id;
end $$;

-- The caller's leagues. The invite code only for commissioners, who decide who gets it.
create or replace function public.my_leagues()
returns table (league_id uuid, name text, role text, invite_code text, self_entry boolean, open_week int)
language sql stable security definer set search_path = public, pg_temp
as $$
  select l.id, l.name, m.role, case when m.role = 'commissioner' then l.invite_code end, l.self_entry, app.open_week_of(l.id)
  from public.league_members m join public.leagues l on l.id = m.league_id
  where m.user_id = auth.uid()
  order by l.created_at, l.id
$$;

create or replace function public.admin_update_league(p_league uuid, p_name text, p_self_entry boolean, p_new_invite boolean default false)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_actor uuid := app.require_commissioner(p_league); v_before public.leagues%rowtype;
begin
  if p_name is null or length(trim(p_name)) not between 1 and 60 then raise exception 'bad_name'; end if;
  select * into v_before from public.leagues where id = p_league for update;
  update public.leagues
     set name = trim(p_name), self_entry = coalesce(p_self_entry, self_entry),
         invite_code = case when p_new_invite then app.new_invite_code() else invite_code end
   where id = p_league;
  perform app.audit(v_actor, 'league_updated', 'league', p_league::text,
    jsonb_build_object('name', v_before.name, 'selfEntry', v_before.self_entry),
    jsonb_build_object('name', trim(p_name), 'selfEntry', coalesce(p_self_entry, v_before.self_entry), 'newInvite', coalesce(p_new_invite, false)),
    null, p_league);
end $$;

-- Makes a member a commissioner, or back to a member. A league always keeps one.
create or replace function public.admin_set_commissioner(p_user uuid, p_on boolean, p_league uuid default null) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_league uuid := app.resolve_league(p_league, true); v_actor uuid := app.require_commissioner(v_league);
begin
  perform 1 from public.leagues where id = v_league for update;
  if not p_on and not exists (select 1 from public.league_members where league_id = v_league and role = 'commissioner' and user_id <> p_user) then
    raise exception 'last_commissioner';
  end if;
  update public.league_members set role = case when p_on then 'commissioner' else 'member' end
   where league_id = v_league and user_id = p_user;
  if not found then raise exception 'not_member'; end if;
  perform app.audit(v_actor, case when p_on then 'commissioner_granted' else 'commissioner_removed' end, 'profile', p_user::text, null,
    jsonb_build_object('member', (select display_name from public.profiles where id = p_user)), null, v_league);
end $$;

-- Takes someone out of the league. Their entries stay; take them off as a manager first.
create or replace function public.admin_remove_member(p_user uuid, p_league uuid default null) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_league uuid := app.resolve_league(p_league, true); v_actor uuid := app.require_commissioner(v_league);
begin
  perform 1 from public.leagues where id = v_league for update;
  if exists (select 1 from public.entry_managers m join public.entries e on e.id = m.entry_id
             where e.league_id = v_league and m.user_id = p_user) then
    raise exception 'manages_entry';
  end if;
  if not exists (select 1 from public.league_members where league_id = v_league and role = 'commissioner' and user_id <> p_user) then
    raise exception 'last_commissioner';
  end if;
  delete from public.league_members where league_id = v_league and user_id = p_user;
  if not found then raise exception 'not_member'; end if;
  perform app.audit(v_actor, 'member_removed', 'profile', p_user::text, null,
    jsonb_build_object('member', (select display_name from public.profiles where id = p_user)), null, v_league);
end $$;

-- For the add-member Edge Function: makes an account a member of the league.
create or replace function public.add_league_member_internal(p_actor uuid, p_league uuid, p_user uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if p_league is null or not app.is_commissioner(p_league, p_actor) then
    raise exception 'commissioner_only' using errcode = '42501';
  end if;
  if app.is_member(p_league, p_user) then return false; end if;
  insert into public.league_members (league_id, user_id) values (p_league, p_user);
  perform app.audit(p_actor, 'member_added', 'profile', p_user::text, null,
    jsonb_build_object('member', (select display_name from public.profiles where id = p_user)), null, p_league);
  return true;
end $$;

create or replace function public.is_commissioner_internal(p_user uuid, p_league uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$ select app.is_commissioner(p_league, p_user) $$;

-- ---------------------------------------------------------------- member functions

drop function public.my_entries();
create or replace function public.my_entries(p_league uuid default null)
returns table (
  entry_id uuid, league_id uuid, name text, available_cents bigint, pending_cents bigint, bank_cents bigint,
  week int, required_cents bigint, wagered_cents bigint
)
language sql stable security definer set search_path = public, pg_temp
as $$
  select e.id, e.league_id, e.name, app.available_cents(e.id), app.pending_cents(e.id), app.bank_cents(e.id),
         w.week, wes.required_cents,
         (select coalesce(sum(s.stake_cents), 0)::bigint from public.slips s
           where s.entry_id = e.id and s.week = w.week and app.counts_toward_minimum(s.status, s.void_reason))
  from public.entries e
  join public.entry_managers m on m.entry_id = e.id and m.user_id = auth.uid()
  left join public.league_weeks w on w.league_id = e.league_id and w.status = 'open'
  left join public.week_entry_status wes on wes.week = w.week and wes.entry_id = e.id
  where e.status = 'active' and (p_league is null or e.league_id = p_league)
  order by e.name
$$;

-- A league's standings, for its members (see 20260929000001_total_risked.sql).
drop function public.standings(timestamptz, timestamptz, int);
create or replace function public.standings(
  p_from timestamptz default null, p_to timestamptz default null, p_week int default null, p_league uuid default null
)
returns table (
  entry_id uuid, name text, is_mine boolean,
  bank_cents bigint, season_net_cents bigint, season_winnings_cents bigint,
  wins int, losses int, pushes int, risk_cents bigint, return_cents bigint, net_cents bigint, winnings_cents bigint,
  at_risk_cents bigint, week int, required_cents bigint, wagered_cents bigint
)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare v_league uuid := app.resolve_league(p_league, false);
begin
  if not app.is_member(v_league) then raise exception 'not_member' using errcode = '42501'; end if;
  return query
  with ow as (select app.open_week_of(v_league) as week),
  lslips as (select s.* from public.slips s where s.league_id = v_league),
  is_season as (select p_from is null and p_to is null and p_week is null as yes),
  settled as (
    select s.entry_id,
      count(*) filter (where s.status = 'won') as w,
      count(*) filter (where s.status = 'lost') as l,
      count(*) filter (where s.status = 'push') as p,
      coalesce(sum(s.stake_cents), 0) as risk,
      coalesce(sum(s.payout_cents), 0) as ret,
      coalesce(sum(s.payout_cents - s.stake_cents) filter (where s.status = 'won'), 0) as winnings
    from lslips s
    where s.status in ('won', 'lost', 'push')
      and (p_week is null or s.week = p_week)
      and (p_from is null or s.settled_at >= p_from)
      and (p_to is null or s.settled_at < p_to)
    group by s.entry_id
  ),
  season_settled as (
    select s.entry_id, coalesce(sum(s.payout_cents - s.stake_cents) filter (where s.status = 'won'), 0) as winnings
    from lslips s where s.status = 'won' group by s.entry_id
  ),
  other as (
    select l.entry_id, coalesce(sum(l.amount_cents), 0) as amt
    from public.ledger l join public.entries e on e.id = l.entry_id and e.league_id = v_league
    where l.kind in ('weekly_minimum', 'adjustment')
      and (p_week is null or l.week = p_week)
      and (p_from is null or l.created_at >= p_from)
      and (p_to is null or l.created_at < p_to)
    group by l.entry_id
  ),
  pend as (
    select s.entry_id,
      sum(s.stake_cents) as all_pending,
      coalesce(sum(s.stake_cents) filter (where app.slip_reveal_at(s.id) <= now()), 0) as revealed_pending
    from lslips s where s.status = 'pending' group by s.entry_id
  ),
  period_pend as (
    select s.entry_id,
      sum(s.stake_cents) as all_pending,
      coalesce(sum(s.stake_cents) filter (where app.slip_reveal_at(s.id) <= now()), 0) as revealed_pending
    from lslips s
    where s.status = 'pending'
      and (p_week is null or s.week = p_week)
      and (p_from is null or s.placed_at >= p_from)
      and (p_to is null or s.placed_at < p_to)
    group by s.entry_id
  ),
  wk as (
    select s.entry_id,
      sum(s.stake_cents) as all_wagered,
      coalesce(sum(s.stake_cents) filter (where app.slip_reveal_at(s.id) <= now()), 0) as revealed_wagered
    from lslips s join ow on s.week = ow.week
    where app.counts_toward_minimum(s.status, s.void_reason)
    group by s.entry_id
  )
  select
    e.id, e.name, app.manages(e.id) as is_mine,
    app.bank_cents(e.id),
    app.bank_cents(e.id) - e.starting_bank_cents,
    (coalesce(b.winnings_cents, 0) + coalesce(ss.winnings, 0))::bigint,
    (coalesce(st.w, 0) + case when (select yes from is_season) then coalesce(b.wins, 0) else 0 end)::int,
    (coalesce(st.l, 0) + case when (select yes from is_season) then coalesce(b.losses, 0) else 0 end)::int,
    (coalesce(st.p, 0) + case when (select yes from is_season) then coalesce(b.pushes, 0) else 0 end)::int,
    (coalesce(st.risk, 0) + case when (select yes from is_season) then coalesce(b.risk_cents, 0) else 0 end
      + case when app.manages(e.id) then coalesce(pp.all_pending, 0) else coalesce(pp.revealed_pending, 0) end)::bigint,
    (coalesce(st.ret, 0) + case when (select yes from is_season) then coalesce(b.return_cents, 0) else 0 end)::bigint,
    case when (select yes from is_season)
      then app.bank_cents(e.id) - e.starting_bank_cents
      else (coalesce(st.ret, 0) - coalesce(st.risk, 0) + coalesce(o.amt, 0))
    end::bigint,
    (coalesce(st.winnings, 0) + case when (select yes from is_season) then coalesce(b.winnings_cents, 0) else 0 end)::bigint,
    (case when app.manages(e.id) then coalesce(pd.all_pending, 0) else coalesce(pd.revealed_pending, 0) end)::bigint,
    (select ow.week from ow),
    wes.required_cents,
    (case when app.manages(e.id) then coalesce(wk.all_wagered, 0) else coalesce(wk.revealed_wagered, 0) end)::bigint
  from public.entries e
  left join settled st on st.entry_id = e.id
  left join season_settled ss on ss.entry_id = e.id
  left join public.entry_baselines b on b.entry_id = e.id
  left join other o on o.entry_id = e.id
  left join pend pd on pd.entry_id = e.id
  left join period_pend pp on pp.entry_id = e.id
  left join wk on wk.entry_id = e.id
  left join public.week_entry_status wes on wes.entry_id = e.id and wes.week = (select ow.week from ow)
  where e.status = 'active' and e.league_id = v_league;
end $$;

drop function public.hidden_activity(int);
create or replace function public.hidden_activity(p_limit int default 50, p_league uuid default null)
returns table (entry_id uuid, name text, placed_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare v_league uuid := app.resolve_league(p_league, false);
begin
  if not app.is_member(v_league) then raise exception 'not_member' using errcode = '42501'; end if;
  return query
    select s.entry_id, e.name, s.placed_at
    from public.slips s join public.entries e on e.id = s.entry_id
    where s.league_id = v_league
      and s.status = 'pending'
      and not app.manages(s.entry_id)
      and app.slip_reveal_at(s.id) > now()
    order by s.placed_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 200);
end $$;

-- ---------------------------------------------------------------- commissioner functions

drop function public.admin_open_next_week(int, text);
create or replace function public.admin_open_next_week(p_expected_open int, p_reason text default null, p_league uuid default null) returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_league uuid := app.resolve_league(p_league, true); v_actor uuid := app.require_commissioner(v_league); v int;
begin
  v := app.advance_week(v_league, v_actor, true, p_expected_open);
  if nullif(trim(p_reason), '') is not null then
    perform app.audit(v_actor, 'week_opened_note', 'week', coalesce(v, p_expected_open)::text, null, null, trim(p_reason), v_league);
  end if;
  return v;
end $$;

drop function public.admin_close_season(int, text);
create or replace function public.admin_close_season(p_expected_open int, p_reason text default null, p_league uuid default null) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_league uuid := app.resolve_league(p_league, true); v_actor uuid := app.require_commissioner(v_league);
begin
  perform app.advance_week(v_league, v_actor, true, p_expected_open, true);
  if nullif(trim(p_reason), '') is not null then
    perform app.audit(v_actor, 'week_opened_note', 'week', p_expected_open::text, null, null, trim(p_reason), v_league);
  end if;
end $$;

drop function public.admin_add_entry(text, bigint);
create or replace function public.admin_add_entry(p_name text, p_starting_bank_cents bigint default 0, p_league uuid default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_league uuid := app.resolve_league(p_league, true); v_actor uuid := app.require_commissioner(v_league); v_id uuid; v_week int;
begin
  if coalesce(p_starting_bank_cents, 0) < 0 then raise exception 'bad_amount'; end if;
  insert into public.entries (league_id, name, starting_bank_cents)
  values (v_league, trim(p_name), coalesce(p_starting_bank_cents, 0)) returning id into v_id;
  if p_starting_bank_cents > 0 then
    insert into public.ledger (entry_id, amount_cents, kind, note, created_by)
    values (v_id, p_starting_bank_cents, 'opening', 'Starting bank', v_actor);
  end if;
  v_week := app.open_week_of(v_league);
  if v_week is not null then perform app.snapshot_entry(v_week, v_id); end if;
  perform app.audit(v_actor, 'entry_added', 'entry', v_id::text, null,
    jsonb_build_object('name', trim(p_name), 'startingBankCents', coalesce(p_starting_bank_cents, 0)), null, v_league);
  return v_id;
end $$;

create or replace function public.admin_import_splash(
  p_entry uuid, p_bank_cents bigint, p_net_cents bigint,
  p_wins int, p_losses int, p_pushes int,
  p_risk_cents bigint, p_return_cents bigint, p_winnings_cents bigint, p_note text
) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_league uuid := app.entry_league(p_entry);
  v_actor uuid := app.require_commissioner(v_league);
  v_before jsonb;
  v_delta bigint;
  v_week int;
begin
  perform 1 from public.entries where id = p_entry for no key update;
  if not found then raise exception 'not_found'; end if;
  if exists (select 1 from public.slips where entry_id = p_entry) then raise exception 'entry_has_bets'; end if;
  if p_bank_cents is null or p_bank_cents < 0 then raise exception 'bad_amount'; end if;
  select jsonb_build_object('bankCents', app.bank_cents(p_entry), 'baseline', to_jsonb(b))
    into v_before from (select 1) x left join public.entry_baselines b on b.entry_id = p_entry;
  v_delta := p_bank_cents - app.available_cents(p_entry);
  if v_delta <> 0 then
    insert into public.ledger (entry_id, amount_cents, kind, note, created_by)
    values (p_entry, v_delta, 'import', coalesce(nullif(trim(p_note), ''), 'Imported standings'), v_actor);
  end if;
  update public.entries set starting_bank_cents = p_bank_cents - coalesce(p_net_cents, 0) where id = p_entry;
  insert into public.entry_baselines (entry_id, wins, losses, pushes, risk_cents, return_cents, winnings_cents, note)
  values (p_entry, coalesce(p_wins, 0), coalesce(p_losses, 0), coalesce(p_pushes, 0), coalesce(p_risk_cents, 0),
          coalesce(p_return_cents, 0), coalesce(p_winnings_cents, 0), coalesce(p_note, ''))
  on conflict (entry_id) do update set wins = excluded.wins, losses = excluded.losses, pushes = excluded.pushes,
    risk_cents = excluded.risk_cents, return_cents = excluded.return_cents, winnings_cents = excluded.winnings_cents,
    note = excluded.note, imported_at = now();
  v_week := app.open_week_of(v_league);
  if v_week is not null then perform app.snapshot_entry(v_week, p_entry); end if;
  perform app.audit(v_actor, 'splash_import', 'entry', p_entry::text, v_before,
    jsonb_build_object('bankCents', p_bank_cents, 'netCents', p_net_cents, 'wins', p_wins, 'losses', p_losses,
      'pushes', p_pushes, 'riskCents', p_risk_cents, 'returnCents', p_return_cents, 'winningsCents', p_winnings_cents),
    p_note, v_league);
end $$;

create or replace function public.admin_adjust_bank(p_entry uuid, p_amount_cents bigint, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_league uuid := app.entry_league(p_entry);
  v_actor uuid := app.require_commissioner(v_league);
  v_reason text := app.require_reason(p_reason);
  v_bank bigint;
begin
  perform 1 from public.entries where id = p_entry for no key update;
  if not found then raise exception 'not_found'; end if;
  if p_amount_cents is null or p_amount_cents = 0 then raise exception 'bad_amount'; end if;
  if app.available_cents(p_entry) + p_amount_cents < 0 then raise exception 'insufficient_units'; end if;
  v_bank := app.bank_cents(p_entry);
  insert into public.ledger (entry_id, amount_cents, kind, week, note, created_by)
  values (p_entry, p_amount_cents, 'adjustment', app.open_week_of(v_league), v_reason, v_actor);
  perform app.audit(v_actor, 'bank_adjusted', 'entry', p_entry::text,
    jsonb_build_object('bankCents', v_bank), jsonb_build_object('bankCents', v_bank + p_amount_cents, 'amountCents', p_amount_cents),
    v_reason, v_league);
end $$;

-- Adds or removes an entry manager (see the first functions migration for the guards).
-- Adding someone makes them a member of the entry's league.
create or replace function public.admin_set_manager(p_entry uuid, p_user uuid, p_add boolean) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_league uuid := app.entry_league(p_entry); v_actor uuid := app.require_commissioner(v_league);
begin
  if not exists (select 1 from public.entries where id = p_entry) then raise exception 'not_found'; end if;
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'not_found'; end if;
  if p_add and p_user = v_actor
     and (exists (select 1 from public.entry_managers where entry_id = p_entry and user_id <> v_actor)
          or exists (select 1 from public.slips where entry_id = p_entry and status = 'pending')) then
    raise exception 'self_add_blocked';
  end if;
  if not p_add
     and not exists (select 1 from public.entry_managers where entry_id = p_entry and user_id <> p_user)
     and exists (select 1 from public.slips where entry_id = p_entry and status = 'pending') then
    raise exception 'last_manager';
  end if;
  if p_add then
    insert into public.league_members (league_id, user_id) values (v_league, p_user) on conflict do nothing;
    insert into public.entry_managers (entry_id, user_id) values (p_entry, p_user) on conflict do nothing;
  else
    delete from public.entry_managers where entry_id = p_entry and user_id = p_user;
  end if;
  perform app.audit(v_actor, case when p_add then 'manager_added' else 'manager_removed' end, 'entry', p_entry::text,
    null, jsonb_build_object('userId', p_user,
      'member', (select display_name from public.profiles where id = p_user),
      'entry', (select name from public.entries where id = p_entry)), null, v_league);
end $$;

create or replace function public.admin_void_slip(p_slip uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_league uuid := (select league_id from public.slips where id = p_slip);
  v_actor uuid := app.require_commissioner(v_league);
  v_reason text := app.require_reason(p_reason);
  v public.slips%rowtype;
  v_shown boolean;
begin
  perform 1 from public.entries e join public.slips s on s.entry_id = e.id where s.id = p_slip for no key update of e;
  perform 1 from public.games g where g.id in (select l.game_id from public.slip_legs l where l.slip_id = p_slip) order by g.id for share;
  select * into v from public.slips where id = p_slip for update;
  if not found then raise exception 'not_found'; end if;
  if v.status in ('void', 'undone') then raise exception 'already_void'; end if;
  if v.status <> 'pending' and coalesce(v.payout_cents, 0) > 0 then
    insert into public.ledger (entry_id, amount_cents, kind, slip_id, week, note, created_by)
    values (v.entry_id, -v.payout_cents, 'void_reversal', v.id, v.week, v_reason, v_actor);
  end if;
  insert into public.ledger (entry_id, amount_cents, kind, slip_id, week, note, created_by)
  values (v.entry_id, v.stake_cents, 'void_refund', v.id, v.week, v_reason, v_actor);
  update public.slips set status = 'void', void_reason = v_reason, payout_cents = v.stake_cents, settled_at = now()
   where id = p_slip;
  perform app.recheck_minimum(v.week, v.entry_id);
  v_shown := app.slip_reveal_at(v.id) <= now();
  perform app.audit(v_actor, 'bet_voided', 'slip', p_slip::text,
    jsonb_build_object('entryId', v.entry_id, 'status', v.status)
      || case when v_shown then jsonb_build_object('stakeCents', v.stake_cents, 'payoutCents', v.payout_cents) else '{}'::jsonb end,
    jsonb_build_object('status', 'void'), v_reason, v_league);
end $$;

-- The league's members and their emails, for its commissioners.
drop function public.admin_list_users();
create or replace function public.admin_list_users(p_league uuid default null)
returns table (user_id uuid, email text, display_name text, is_commissioner boolean, entry_names text[])
language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare v_league uuid := app.resolve_league(p_league, true);
begin
  perform app.require_commissioner(v_league);
  return query
    select p.id, u.email::text, p.display_name, lm.role = 'commissioner',
           coalesce(array_agg(e.name order by e.name) filter (where e.id is not null), '{}')
    from public.league_members lm
    join public.profiles p on p.id = lm.user_id
    join auth.users u on u.id = p.id
    left join public.entry_managers m on m.user_id = p.id
    left join public.entries e on e.id = m.entry_id and e.league_id = v_league
    where lm.league_id = v_league
    group by p.id, u.email, p.display_name, lm.role
    order by p.display_name;
end $$;

-- Problems for the admin screens: for a site admin, failed pulls and games that need a
-- hand (shared by every league); for a league's commissioner, that league's entries
-- that share a manager and bet against each other (once both picks are public).
drop function public.admin_recent_problems(int);
create or replace function public.admin_recent_problems(p_limit int default 10, p_league uuid default null)
returns table (at timestamptz, kind text, trigger text, error text)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare v_site boolean := app.is_admin(); v_league uuid;
begin
  v_league := case when p_league is not null and app.is_commissioner(p_league) then p_league end;
  if not v_site and v_league is null then raise exception 'admin_only' using errcode = '42501'; end if;
  return query
    select * from (
      select max(lp.at) as at, lp.kind, lp.trigger,
             coalesce(lp.error, '') || case when count(*) > 1 then format(' (%s times)', count(*)) else '' end as error
      from public.line_pulls lp
      where v_site and not lp.ok and lp.at > now() - interval '3 days'
      group by lp.kind, lp.trigger, coalesce(lp.error, '')
      union all
      select g.kickoff_at + interval '5 hours', 'game', 'check',
             format('%s at %s has been live for over 5 hours with no final. Enter its final score.', ta.short_name, th.short_name)
      from public.games g join public.teams th on th.abbr = g.home_team join public.teams ta on ta.abbr = g.away_team
      where v_site and g.status = 'live' and g.kickoff_at < now() - interval '5 hours'
      union all
      select least(g.kickoff_at, g.feed_commence) + interval '1 hour', 'game', 'check',
             format('%s at %s should have started by now but has no score yet, so betting on it is closed. If it was postponed, mark it postponed; otherwise the score feed may be behind.', ta.short_name, th.short_name)
      from public.games g join public.teams th on th.abbr = g.home_team join public.teams ta on ta.abbr = g.away_team
      where v_site and g.status = 'scheduled' and least(g.kickoff_at, g.feed_commence) < now() - interval '1 hour'
      union all
      select max(p.kickoff_at), 'fair_play', 'check',
             format('%s and %s, which share a manager (%s), took opposite sides of %s at %s.',
                    least(p.a_name, p.b_name), greatest(p.a_name, p.b_name),
                    string_agg(distinct p.manager, ', ' order by p.manager), p.away, p.home)
      from (
        select ea.id as a_id, ea.name as a_name, eb.id as b_id, eb.name as b_name, g.id as game_id, g.kickoff_at,
               th.short_name as home, ta.short_name as away, pr.display_name as manager
        from public.slip_legs la
        join public.slips sa on sa.id = la.slip_id and sa.league_id = v_league
        join public.slip_legs lb on lb.game_id = la.game_id
        join public.slips sb on sb.id = lb.slip_id and sb.entry_id > sa.entry_id and sb.league_id = v_league
        join lateral (
          select ma.user_id
          from public.entry_managers ma
          join public.entry_managers mb on mb.entry_id = sb.entry_id and mb.user_id = ma.user_id and mb.added_at <= sb.placed_at
          where ma.entry_id = sa.entry_id and ma.added_at <= sa.placed_at
          union
          select sa.placed_by where sa.placed_by = sb.placed_by
        ) m on true
        join public.profiles pr on pr.id = m.user_id
        join public.entries ea on ea.id = sa.entry_id
        join public.entries eb on eb.id = sb.entry_id
        join public.games g on g.id = la.game_id
        join public.teams th on th.abbr = g.home_team join public.teams ta on ta.abbr = g.away_team
        where v_league is not null
          and sa.status not in ('undone', 'void') and sb.status not in ('undone', 'void')
          and (la.market = 'total') = (lb.market = 'total') and la.side <> lb.side
          and g.kickoff_at > now() - interval '7 days'
          and app.leg_public(sa.id, la.game_id) and app.leg_public(sb.id, lb.game_id)
      ) p
      group by p.a_id, p.a_name, p.b_id, p.b_name, p.game_id, p.home, p.away
      union all
      select coalesce(g.rescheduled_at, g.kickoff_at) + interval '3 days', 'game', 'check',
             format('%s at %s was postponed and the feed has stopped checking it. Enter its final score, or void it.', ta.short_name, th.short_name)
      from public.games g join public.teams th on th.abbr = g.home_team join public.teams ta on ta.abbr = g.away_team
      where v_site and g.status = 'postponed' and coalesce(g.rescheduled_at, g.kickoff_at) < now() - interval '3 days'
    ) x
    order by x.at desc
    limit least(greatest(coalesce(p_limit, 10), 1), 50);
end $$;

-- ---------------------------------------------------------------- site admin functions

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
  if p_status = 'void' and g.status = 'final' then
    v_reopened := app.reopen_graded(p_game, v_actor, v_reason);
  end if;
  update public.games
     set status = p_status,
         kickoff_at = coalesce(p_kickoff_at, kickoff_at),
         feed_final_home = null,
         feed_final_away = null,
         feed_kickoff = null,
         rescheduled_at = case when p_status = 'postponed' then rescheduled_at end,
         updated_at = v_now
   where id = p_game;
  perform app.audit(v_actor, 'game_status_set', 'game', p_game::text,
    jsonb_build_object('status', g.status, 'kickoffAt', g.kickoff_at),
    jsonb_build_object('status', p_status, 'kickoffAt', coalesce(p_kickoff_at, g.kickoff_at), 'betsRegraded', v_reopened), v_reason);
end $$;

-- Moves a game to another week: only while no league has opened its week (so it has no
-- bets), and never into a week some league has closed.
create or replace function public.admin_move_game(p_game uuid, p_week int, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_actor uuid := app.require_admin(); v_reason text := app.require_reason(p_reason); v_old int;
begin
  select week into v_old from public.games where id = p_game for update;
  if not found then raise exception 'not_found'; end if;
  if exists (select 1 from public.league_weeks where week = v_old and status <> 'upcoming') then raise exception 'week_already_open'; end if;
  if exists (select 1 from public.slip_legs where game_id = p_game) then raise exception 'game_has_bets'; end if;
  if not exists (select 1 from public.weeks where week = p_week)
     or exists (select 1 from public.league_weeks where week = p_week and status = 'closed') then
    raise exception 'unknown_week';
  end if;
  update public.games set week = p_week, week_moved = true, updated_at = now() where id = p_game;
  perform app.audit(v_actor, 'game_moved', 'game', p_game::text, jsonb_build_object('week', v_old), jsonb_build_object('week', p_week), v_reason);
end $$;

-- Site admins: other site admins. Being one gives no say in anyone's league.
create or replace function public.admin_list_site_admins()
returns table (user_id uuid, display_name text)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  perform app.require_admin();
  return query select p.id, p.display_name from public.profiles p where p.is_admin order by p.display_name;
end $$;

-- ---------------------------------------------------------------- access

alter table public.leagues enable row level security;
alter table public.league_members enable row level security;
alter table public.league_weeks enable row level security;

revoke all on public.leagues, public.league_members, public.league_weeks from anon, authenticated;
grant select (id, name, self_entry, created_by, created_at) on public.leagues to authenticated;
grant select on public.league_members, public.league_weeks to authenticated;

create policy members_read on public.leagues for select to authenticated using (app.is_member(id));
create policy members_read on public.league_members for select to authenticated using (app.is_member(league_id));
create policy members_read on public.league_weeks for select to authenticated using (app.is_member(league_id));

-- Each league's own rows only to its members.
drop policy members_read on public.entries;
create policy members_read on public.entries for select to authenticated using (app.is_member(league_id));
drop policy members_read on public.entry_managers;
create policy members_read on public.entry_managers for select to authenticated
  using (app.is_member(app.entry_league(entry_id)));
drop policy members_read on public.rule_sets;
create policy members_read on public.rule_sets for select to authenticated using (league_id is null or app.is_member(league_id));
drop policy members_read on public.week_entry_status;
create policy members_read on public.week_entry_status for select to authenticated
  using (app.is_member(app.entry_league(entry_id)));
drop policy members_read on public.entry_baselines;
create policy members_read on public.entry_baselines for select to authenticated
  using (app.is_member(app.entry_league(entry_id)));
drop policy members_read on public.audit_log;
create policy members_read on public.audit_log for select to authenticated using (league_id is null or app.is_member(league_id));
drop policy ledger_read on public.ledger;
create policy ledger_read on public.ledger for select to authenticated
  using (case when slip_id is null then app.is_member(app.entry_league(entry_id)) else app.can_see_slip(slip_id) end);
-- Display names: your own, and those of people in a league with you.
drop policy members_read on public.profiles;
create policy members_read on public.profiles for select to authenticated
  using (id = auth.uid() or exists (
    select 1 from public.league_members a join public.league_members b on b.league_id = a.league_id
    where a.user_id = auth.uid() and b.user_id = profiles.id));

grant select (id, entry_id, league_id, placed_by, week, type, teaser_points, stake_cents, leg_count, rule_set_version,
              status, payout_cents, placed_at, settled_at, undone_at, void_reason)
  on public.slips to authenticated;

revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema app from public, anon, authenticated;

grant execute on function app.manages(uuid, uuid) to authenticated;
grant execute on function app.can_see_slip(uuid) to authenticated;
grant execute on function app.can_see_leg(uuid, uuid) to authenticated;
grant execute on function app.is_member(uuid, uuid) to authenticated;
grant execute on function app.entry_league(uuid) to authenticated;

grant execute on function public.set_display_name(text) to authenticated;
grant execute on function public.my_entries(uuid) to authenticated;
grant execute on function public.standings(timestamptz, timestamptz, int, uuid) to authenticated;
grant execute on function public.hidden_activity(int, uuid) to authenticated;
grant execute on function public.slip_quotes(uuid[]) to authenticated;
grant execute on function public.create_league(text) to authenticated;
grant execute on function public.league_by_invite(text) to authenticated;
grant execute on function public.join_league(text, text) to authenticated;
grant execute on function public.my_leagues() to authenticated;

grant execute on function public.admin_update_league(uuid, text, boolean, boolean) to authenticated;
grant execute on function public.admin_set_commissioner(uuid, boolean, uuid) to authenticated;
grant execute on function public.admin_remove_member(uuid, uuid) to authenticated;
grant execute on function public.admin_open_next_week(int, text, uuid) to authenticated;
grant execute on function public.admin_close_season(int, text, uuid) to authenticated;
grant execute on function public.admin_add_entry(text, bigint, uuid) to authenticated;
grant execute on function public.admin_import_splash(uuid, bigint, bigint, int, int, int, bigint, bigint, bigint, text) to authenticated;
grant execute on function public.admin_adjust_bank(uuid, bigint, text) to authenticated;
grant execute on function public.admin_set_manager(uuid, uuid, boolean) to authenticated;
grant execute on function public.admin_void_slip(uuid, text) to authenticated;
grant execute on function public.admin_list_users(uuid) to authenticated;
grant execute on function public.admin_recent_problems(int, uuid) to authenticated;

grant execute on function public.admin_set_admin(uuid, boolean) to authenticated;
grant execute on function public.admin_list_site_admins() to authenticated;
grant execute on function public.admin_set_line(uuid, text, numeric, int, numeric, int, boolean, text) to authenticated;
grant execute on function public.admin_clear_line(uuid, text, text) to authenticated;
grant execute on function public.admin_set_game_status(uuid, text, timestamptz, text) to authenticated;
grant execute on function public.admin_set_final_score(uuid, int, int, text) to authenticated;
grant execute on function public.admin_move_game(uuid, int, text) to authenticated;

grant execute on all functions in schema public to service_role;
grant execute on all functions in schema app to service_role;
