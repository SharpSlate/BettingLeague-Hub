-- Player props (2026-10-05): anytime TD, receptions, rushing, receiving and passing
-- yards, main lines only. A league offers them only once its commissioner turns them
-- on in the rules ("props"). Rule sets from before this have no props section, which
-- means no props.
--
-- The lines come from the site owner's own scheduled prop pulls, which send them here
-- through the import-props function (ingest_props_internal), so props spend none of
-- this site's Odds API credits. They're graded from ESPN's box scores.

-- ---------------------------------------------------------------- settings

-- Bets on props are refused once the latest import is older than this. The owner's
-- pulls run twice a day (six times on Sundays).
alter table public.league_settings
  add column prop_max_age_minutes int not null default 1080 check (prop_max_age_minutes > 0);

-- The SHA-256 (hex) of the key the owner's prop sender presents; only the hash is kept,
-- out of members' reach. A new key is a new row here (an update, or a migration).
create table app.prop_import_key (
  id boolean primary key default true check (id),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$')
);
insert into app.prop_import_key (sha256) values ('19e06a3e23a219bed73e56b53551616d0e3b5803c06ee5fc830d327337527f97');
revoke all on app.prop_import_key from public, anon, authenticated;

-- ---------------------------------------------------------------- tables

-- One row per import from the owner's prop pulls.
create table public.prop_imports (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  -- When the sender pulled these props from the books: how old they really are.
  pulled_at timestamptz not null,
  source text not null default '',
  ok boolean not null,
  games int,
  lines int,
  error text
);
create index on public.prop_imports (ok, at desc);

-- The latest number each book offered on each player's prop.
create table public.prop_lines (
  game_id uuid not null references public.games (id) on delete cascade,
  market text not null check (market in ('anytime_td', 'receptions', 'rush_yds', 'rec_yds', 'pass_yds')),
  -- The player as the books name him ("Josh Allen").
  player text not null check (length(player) between 1 and 80),
  side text not null check (side in ('over', 'under', 'yes')),
  book text not null,
  point numeric(5, 1),
  price int not null check (abs(price) >= 100),
  -- The import that last saw this line; lines not in the latest good import are off the board.
  seen_at timestamptz not null,
  changed_at timestamptz not null,
  primary key (game_id, market, player, side, book),
  check ((market = 'anytime_td') = (side = 'yes')),
  check ((market = 'anytime_td') = (point is null))
);

-- Whether a game's box score has been read (from ESPN once it's final, or set by a
-- site admin when ESPN doesn't have it). Props on a final game wait for it.
create table public.game_boxes (
  game_id uuid primary key references public.games (id) on delete cascade,
  espn_id text,
  source text not null check (source in ('espn', 'admin')),
  loaded_at timestamptz not null default now()
);

-- Each player's stats from a final box score, and site admins' corrections. A player
-- with props who isn't in the box score didn't play, and his props are void (as at the
-- books), unless a site admin enters his stats.
create table public.player_stats (
  id bigint generated always as identity primary key,
  game_id uuid not null references public.games (id) on delete cascade,
  player text not null check (length(player) between 1 and 80),
  team text,
  source text not null check (source in ('espn', 'admin')),
  -- Admin rows only: false says he didn't play, so his props are void.
  played boolean not null default true,
  pass_yds int not null default 0,
  rush_yds int not null default 0,
  rec_yds int not null default 0,
  receptions int not null default 0 check (receptions >= 0),
  -- Touchdowns he scored himself: rushing, receiving, returns (not passing).
  tds int not null default 0 check (tds >= 0),
  set_by uuid references public.profiles (id),
  reason text not null default '',
  at timestamptz not null default now()
);
create index on public.player_stats (game_id);
-- One admin row per player per game (a new one replaces it).
create unique index player_stats_one_admin on public.player_stats (game_id, lower(player)) where source = 'admin';

-- ---------------------------------------------------------------- bets

alter table public.slip_legs add column player text;
alter table public.slip_legs drop constraint slip_legs_market_check;
alter table public.slip_legs drop constraint slip_legs_side_check;
alter table public.slip_legs
  add constraint slip_legs_market_check
    check (market in ('spread', 'total', 'moneyline', 'anytime_td', 'receptions', 'rush_yds', 'rec_yds', 'pass_yds')),
  add constraint slip_legs_side_check check (side in ('home', 'away', 'over', 'under', 'yes')),
  add constraint slip_legs_player_check
    check ((market in ('spread', 'total', 'moneyline')) = (player is null));
drop index public.slip_legs_one_per_pick;
create unique index slip_legs_one_per_pick on public.slip_legs (slip_id, game_id, market, side) where player is null;
-- One pick per player on a slip.
create unique index slip_legs_one_per_player on public.slip_legs (slip_id, game_id, player) where player is not null;

create or replace function app.is_prop(p_market text) returns boolean
language sql immutable
as $$ select p_market in ('anytime_td', 'receptions', 'rush_yds', 'rec_yds', 'pass_yds') $$;

-- Whether two picks on one game take opposite sides: both teams (by spread or moneyline,
-- in any mix), the over and the under of the total, or of one player's prop.
create or replace function app.opposite_picks(m1 text, s1 text, p1 text, m2 text, s2 text, p2 text) returns boolean
language sql immutable
as $$
  select s1 <> s2 and case
    when app.is_prop(m1) or app.is_prop(m2) then m1 = m2 and coalesce(p1, '') = coalesce(p2, '')
    else (m1 = 'total') = (m2 = 'total')
  end
$$;

create or replace function app.legs_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then raise exception 'legs cannot be deleted'; end if;
  if tg_op = 'INSERT' then
    if exists (select 1 from public.games g where g.id = new.game_id
               and (least(g.kickoff_at, g.feed_commence) <= clock_timestamp() or g.status <> 'scheduled')) then
      raise exception 'game_started';
    end if;
    return new;
  end if;
  if (new.slip_id, new.leg_no, new.game_id, new.market, new.side, new.point, new.price, new.teased_point, new.book, new.player)
     is distinct from
     (old.slip_id, old.leg_no, old.game_id, old.market, old.side, old.point, old.price, old.teased_point, old.book, old.player) then
    raise exception 'a placed leg cannot be changed';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- the board

-- The prop line the league offers right now for each game, market, player and side: the
-- highest-priority book (league_settings.books) offering the whole prop (both the over
-- and the under at one number, or the anytime TD) in the latest good import. as_of is
-- when the sender pulled it from the books.
create view public.current_props with (security_invoker = true) as
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
),
chosen as (
  select distinct on (game_id, market, player) game_id, market, player, book from offered order by game_id, market, player, ord
)
select pl.game_id, pl.market, pl.player, pl.side, pl.point, pl.price, pl.book as source, li.pulled_at as as_of
from public.prop_lines pl
join chosen c on c.game_id = pl.game_id and c.market = pl.market and c.player = pl.player and c.book = pl.book
cross join last_import li;

-- Stores an import from the owner's prop pulls. p_key is checked against the stored hash.
-- p_quotes: [{eventId, market (the Odds API's key), player, side, point, price, book}].
-- Only games still open for betting take new lines. A pull older than the latest one
-- stored is refused, so a late resend can't put old prices back on the board.
create or replace function public.ingest_props_internal(
  p_key text, p_pulled_at timestamptz, p_source text, p_quotes jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_hash text;
  v_now timestamptz := clock_timestamp();
  v_latest timestamptz;
  v_games int;
  v_lines int;
begin
  select sha256 into v_hash from app.prop_import_key;
  if v_hash is null or p_key is null or encode(sha256(convert_to(p_key, 'UTF8')), 'hex') <> v_hash then
    raise exception 'bad_key' using errcode = '42501';
  end if;
  if p_pulled_at is null or p_pulled_at > v_now + interval '5 minutes' or p_pulled_at < v_now - interval '3 days' then
    raise exception 'bad_pulled_at';
  end if;
  if jsonb_typeof(p_quotes) is distinct from 'array' then raise exception 'bad_quotes'; end if;
  perform pg_advisory_xact_lock(hashtext('ingest_props'));
  select max(pulled_at) into v_latest from public.prop_imports where ok;
  if p_pulled_at < v_latest then raise exception 'older_than_latest'; end if;

  -- The games taking new lines, locked in id order as the line pulls lock them, so a bet
  -- being placed on one of them finishes first, or waits for the new lines.
  perform 1 from public.games g
   where g.odds_api_id in (select x ->> 'eventId' from jsonb_array_elements(p_quotes) x where jsonb_typeof(x) = 'object')
     and g.status = 'scheduled' and least(g.kickoff_at, g.feed_commence) > v_now
   order by g.id for no key update;

  with q as (
    select g.id as game_id,
           case x ->> 'market'
             when 'player_anytime_td' then 'anytime_td'
             when 'player_receptions' then 'receptions'
             when 'player_rush_yds' then 'rush_yds'
             when 'player_reception_yds' then 'rec_yds'
             when 'player_pass_yds' then 'pass_yds'
           end as market,
           trim(x ->> 'player') as player,
           lower(trim(x ->> 'side')) as side,
           regexp_replace(lower(coalesce(x ->> 'book', '')), '[^a-z0-9]', '', 'g') as book,
           case when jsonb_typeof(x -> 'point') = 'number' then (x ->> 'point')::numeric end as point,
           case when jsonb_typeof(x -> 'price') = 'number' and (x ->> 'price') ~ '^-?[0-9]{3,6}$' then (x ->> 'price')::int end as price
    from jsonb_array_elements(p_quotes) x
    join public.games g on g.odds_api_id = x ->> 'eventId'
    where jsonb_typeof(x) = 'object'
      and g.status = 'scheduled' and least(g.kickoff_at, g.feed_commence) > v_now
  ),
  good as (
    select * from q
    where market is not null and length(player) between 1 and 80 and book <> '' and price is not null and abs(price) >= 100
      and case when market = 'anytime_td' then side = 'yes' and point is null
               else side in ('over', 'under') and point > 0 and point < 1000 and point * 2 = trunc(point * 2) end
  ),
  -- A book quoting one player's prop twice (two numbers) is ambiguous: leave it out.
  incoming as (
    select game_id, market, player, side, book, min(point) as point, min(price) as price
    from good
    group by game_id, market, player, side, book
    having count(*) = 1
  ),
  stored as (
    insert into public.prop_lines (game_id, market, player, side, book, point, price, seen_at, changed_at)
    select game_id, market, player, side, book, point, price, v_now, v_now from incoming
    on conflict (game_id, market, player, side, book) do update
      set changed_at = case when (prop_lines.point, prop_lines.price) is distinct from (excluded.point, excluded.price)
                            then excluded.seen_at else prop_lines.changed_at end,
          point = excluded.point, price = excluded.price, seen_at = excluded.seen_at
    returning game_id
  )
  select count(distinct game_id), count(*) into v_games, v_lines from stored;
  insert into public.prop_imports (at, pulled_at, source, ok, games, lines)
  values (v_now, p_pulled_at, left(coalesce(p_source, ''), 80), true, v_games, v_lines);
  return jsonb_build_object('games', v_games, 'lines', v_lines);
end $$;

-- An import that couldn't be stored, for the Admin page.
create or replace function public.record_prop_import_failure_internal(p_pulled_at timestamptz, p_source text, p_error text) returns void
language sql security definer set search_path = public, pg_temp
as $$
  insert into public.prop_imports (pulled_at, source, ok, error)
  values (coalesce(p_pulled_at, now()), left(coalesce(p_source, ''), 80), false, left(coalesce(p_error, ''), 300))
$$;

-- ---------------------------------------------------------------- grading

-- Final games with props riding whose box score hasn't been read yet, for the score job.
create or replace function public.games_needing_boxes_internal()
returns table (game_id uuid, kickoff_at timestamptz, home_name text, away_name text)
language sql stable security definer set search_path = public, pg_temp
as $$
  select g.id, g.kickoff_at, th.name, ta.name
  from public.games g
  join public.teams th on th.abbr = g.home_team
  join public.teams ta on ta.abbr = g.away_team
  where g.status = 'final'
    and not exists (select 1 from public.game_boxes b where b.game_id = g.id)
    and exists (select 1 from public.slip_legs l join public.slips s on s.id = l.slip_id
                where l.game_id = g.id and l.player is not null and s.status = 'pending')
  order by g.kickoff_at
$$;

-- Stores a final game's box score from ESPN, once. p_players: [{player, team, passYds,
-- rushYds, recYds, receptions, tds}].
create or replace function public.ingest_box_internal(p_game uuid, p_espn_id text, p_players jsonb) returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_n int;
begin
  perform 1 from public.games where id = p_game and status = 'final' for share;
  if not found then raise exception 'game_not_final'; end if;
  if jsonb_typeof(p_players) is distinct from 'array' then raise exception 'bad_players'; end if;
  insert into public.game_boxes (game_id, espn_id, source) values (p_game, p_espn_id, 'espn')
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

-- Sets a player's stats on a final game by hand, or says he didn't play (p_played false),
-- when ESPN's box score is missing him or has him wrong. p_player is his name as the
-- props name him. Bets already graded on the game are graded again (app.reopen_graded).
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
  -- A game ESPN never posted a box score for: the admin's rows are the box score.
  insert into public.game_boxes (game_id, source) values (p_game, 'admin') on conflict (game_id) do nothing;
  v_reopened := app.reopen_graded(p_game, v_actor, v_reason);
  update public.games set updated_at = clock_timestamp() where id = p_game;
  perform app.audit(v_actor, 'player_stats_set', 'game', p_game::text, v_before,
    jsonb_build_object('player', v_player, 'played', p_played, 'passYds', p_pass_yds, 'rushYds', p_rush_yds,
                       'recYds', p_rec_yds, 'receptions', p_receptions, 'tds', p_tds, 'betsRegraded', v_reopened),
    v_reason);
end $$;

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

create or replace function app.opposite_side_legs(p_entry uuid, p_user uuid, p_legs jsonb) returns setof int
language sql stable security definer set search_path = public, pg_temp
as $$
  select distinct (x.n - 1)::int
  from jsonb_array_elements(p_legs) with ordinality as x(leg, n)
  join public.slip_legs l on l.game_id = (x.leg ->> 'gameId')::uuid
  join public.slips s on s.id = l.slip_id
  where s.entry_id = p_entry and s.status = 'pending'
    and (s.placed_by = p_user or app.managed_at(s.entry_id, s.placed_at, p_user) or app.leg_public(s.id, l.game_id))
    and app.opposite_picks(l.market, l.side, l.player, x.leg ->> 'market', x.leg ->> 'side', x.leg ->> 'player')
$$;

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
  v_now := clock_timestamp();
  select document into v_doc from public.rule_sets where version = v.rule_set_version;
  if v_now > v.placed_at + make_interval(secs => coalesce((v_doc ->> 'undoMinutes')::numeric, 0) * 60) then raise exception 'undo_window_passed'; end if;
  if app.slip_locks_at(v.id) <= v_now then raise exception 'game_started'; end if;
  v_checked := not coalesce((v_doc ->> 'undoAfterLineMove')::boolean, false);
  -- Props can't be pulled on demand: they're compared with the latest import from the
  -- owner's pulls, so a bet of props alone needs no fresh pull of the game lines (and a
  -- prop that has moved at the books since that import can still be undone).
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

-- New leagues start from rule set 1, so it gets the props section (off) the day-one
-- rules now carry. It's the template no league plays under, so nothing changes for
-- anyone's bets.
alter table public.rule_sets disable trigger rule_sets_append_only;
update public.rule_sets
   set document = document || '{"props": {"enabled": false, "markets": ["anytime_td", "receptions", "rush_yds", "rec_yds", "pass_yds"], "maxPerGame": 2, "maxStakePct": 50}}'::jsonb
 where version = 1 and league_id is null and not document ? 'props';
alter table public.rule_sets enable trigger rule_sets_append_only;

-- ---------------------------------------------------------------- admin

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
      -- Prop imports from the owner's pulls that couldn't be stored.
      select max(pi.at), 'props', 'import',
             coalesce(pi.error, '') || case when count(*) > 1 then format(' (%s times)', count(*)) else '' end
      from public.prop_imports pi
      where v_site and not pi.ok and pi.at > now() - interval '3 days'
      group by coalesce(pi.error, '')
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
          and app.opposite_picks(la.market, la.side, la.player, lb.market, lb.side, lb.player)
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

-- ---------------------------------------------------------------- access

alter table public.prop_imports enable row level security;
alter table public.prop_lines enable row level security;
alter table public.game_boxes enable row level security;
alter table public.player_stats enable row level security;

revoke all on public.prop_imports, public.prop_lines, public.game_boxes, public.player_stats from anon, authenticated;
revoke all on public.current_props from anon, authenticated;
grant select (id, at, pulled_at, ok, games, lines) on public.prop_imports to authenticated;
grant select on public.prop_lines, public.game_boxes, public.player_stats to authenticated;
grant select on public.current_props to authenticated;

create policy members_read on public.prop_imports for select to authenticated using (true);
create policy members_read on public.prop_lines for select to authenticated using (true);
create policy members_read on public.game_boxes for select to authenticated using (true);
create policy members_read on public.player_stats for select to authenticated using (true);

revoke execute on function app.is_prop(text) from public, anon, authenticated;
revoke execute on function app.opposite_picks(text, text, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.ingest_props_internal(text, timestamptz, text, jsonb) from public, anon, authenticated;
revoke execute on function public.record_prop_import_failure_internal(timestamptz, text, text) from public, anon, authenticated;
revoke execute on function public.games_needing_boxes_internal() from public, anon, authenticated;
revoke execute on function public.ingest_box_internal(uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public.admin_set_player_stats(uuid, text, boolean, int, int, int, int, int, text) from public, anon;
grant execute on function public.admin_set_player_stats(uuid, text, boolean, int, int, int, int, int, text) to authenticated;
grant execute on all functions in schema public to service_role;
grant execute on all functions in schema app to service_role;
