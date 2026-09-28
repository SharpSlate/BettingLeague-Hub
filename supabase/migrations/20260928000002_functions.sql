-- Server functions and guards.
--
-- Naming: public.*_internal functions are for the Edge Functions (service role only).
-- public.admin_* functions check the caller is an admin and write an audit row.
-- app.* functions are internal helpers; the app schema is not exposed by the API.
--
-- Every function that can run for a signed-in member is SECURITY DEFINER with a fixed
-- search_path, and checks its caller itself. Execute grants are in the next migration;
-- any new function must be added to them.

-- ---------------------------------------------------------------- helpers

create or replace function app.is_admin(p_user uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$ select coalesce((select is_admin from public.profiles where id = p_user), false) $$;

create or replace function app.manages(p_entry uuid, p_user uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select p_user is not null
     and exists (select 1 from public.entry_managers where entry_id = p_entry and user_id = p_user)
$$;

-- Whether the user already managed the entry at a given moment. Hidden bets are shown
-- only to managers who were managers when the bet was placed, so an admin can't make
-- themselves a manager to look at bets that are already on the board.
create or replace function app.managed_at(p_entry uuid, p_at timestamptz, p_user uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select p_user is not null
     and exists (select 1 from public.entry_managers where entry_id = p_entry and user_id = p_user and added_at <= p_at)
$$;

create or replace function app.require_admin() returns uuid
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v uuid := auth.uid();
begin
  if v is null or not app.is_admin(v) then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  return v;
end $$;

create or replace function app.audit(
  p_actor uuid, p_action text, p_target_type text, p_target_id text, p_before jsonb, p_after jsonb, p_reason text
) returns void
language sql security definer set search_path = public, pg_temp
as $$
  insert into public.audit_log (actor, action, target_type, target_id, before, after, reason)
  values (p_actor, p_action, p_target_type, p_target_id, p_before, p_after, coalesce(p_reason, ''))
$$;

create or replace function app.require_reason(p_reason text) returns text
language plpgsql immutable
as $$
begin
  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'reason_required';
  end if;
  return trim(p_reason);
end $$;

create or replace function app.available_cents(p_entry uuid) returns bigint
language sql stable security definer set search_path = public, pg_temp
as $$ select coalesce(sum(amount_cents), 0)::bigint from public.ledger where entry_id = p_entry $$;

create or replace function app.pending_cents(p_entry uuid) returns bigint
language sql stable security definer set search_path = public, pg_temp
as $$ select coalesce(sum(stake_cents), 0)::bigint from public.slips where entry_id = p_entry and status = 'pending' $$;

-- Whether a bet counts toward its week's minimum. Every bet does except one the member
-- undid or an admin voided (void_reason is set only by an admin void): pushes count, and
-- so do bets graded void because their game was cancelled.
create or replace function app.counts_toward_minimum(p_status text, p_void_reason text) returns boolean
language sql immutable
as $$ select p_status <> 'undone' and not (p_status = 'void' and p_void_reason is not null) $$;

-- Bank = available + stakes still riding. Placing a bet doesn't change it.
create or replace function app.bank_cents(p_entry uuid) returns bigint
language sql stable security definer set search_path = public, pg_temp
as $$ select app.available_cents(p_entry) + app.pending_cents(p_entry) $$;

create or replace function app.week_for(p_at timestamptz) returns int
language sql stable security definer set search_path = public, pg_temp
as $$ select week from public.weeks where p_at >= starts_at and p_at < ends_at $$;

-- The rule set in effect for a week: the one with the latest start at or before it
-- (the newest version, if two start the same week).
create or replace function app.rule_set_for_week(p_week int) returns int
language sql stable security definer set search_path = public, pg_temp
as $$
  select version from public.rule_sets where effective_week <= p_week
  order by effective_week desc, version desc limit 1
$$;

-- ceil(pct% of the bank) in whole units, in cents. Mirrors requiredMinimumCents in the rules module.
create or replace function app.required_cents(p_bank bigint, p_doc jsonb) returns bigint
language sql immutable
as $$
  select case
    when p_bank <= 0 then 0::bigint
    else (ceil((p_bank::numeric * round((p_doc -> 'weeklyMinimum' ->> 'pct')::numeric * 100)) / 1000000) * 100)::bigint
  end
$$;

create or replace function app.first_kickoff(p_slip uuid) returns timestamptz
language sql stable security definer set search_path = public, pg_temp
as $$
  select min(g.kickoff_at) from public.slip_legs l join public.games g on g.id = l.game_id where l.slip_id = p_slip
$$;

-- When betting closed on the slip's first game: its kickoff, or the feed's own start
-- time if that came first (see games.feed_commence).
create or replace function app.slip_locks_at(p_slip uuid) returns timestamptz
language sql stable security definer set search_path = public, pg_temp
as $$
  select min(least(g.kickoff_at, g.feed_commence)) from public.slip_legs l join public.games g on g.id = l.game_id where l.slip_id = p_slip
$$;

-- When other members may see a slip, per the visibility rule of the slip's rule set.
create or replace function app.slip_reveal_at(p_slip uuid) returns timestamptz
language sql stable security definer set search_path = public, pg_temp
as $$
  select case r.document ->> 'visibility'
      when 'on_placement' then s.placed_at
      when 'week_first_kickoff' then (select min(g.kickoff_at) from public.games g where g.week = s.week and g.status <> 'void')
      else app.first_kickoff(s.id)
    end
  from public.slips s join public.rule_sets r on r.version = s.rule_set_version
  where s.id = p_slip
$$;

create or replace function app.can_see_slip(p_slip uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.slips s
    where s.id = p_slip
      and (s.placed_by = auth.uid() or app.managed_at(s.entry_id, s.placed_at)
           or (s.status <> 'undone' and app.slip_reveal_at(s.id) <= now()))
  )
$$;

-- A leg is revealed at its own game's kickoff under the default rule; otherwise with its slip.
create or replace function app.can_see_leg(p_slip uuid, p_game uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.slips s
    join public.rule_sets r on r.version = s.rule_set_version
    join public.games g on g.id = p_game
    where s.id = p_slip
      and (
        s.placed_by = auth.uid()
        or app.managed_at(s.entry_id, s.placed_at)
        or (
          s.status <> 'undone'
          and case r.document ->> 'visibility'
                when 'kickoff_per_leg' then g.kickoff_at <= now()
                else app.slip_reveal_at(s.id) <= now()
              end
        )
      )
  )
$$;

-- A slip's combined odds and payout. A parlay's combined odds would give away the
-- legs that are still hidden, so other members see them only once every leg is shown.
create or replace function app.can_see_quote(p_slip uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.slips s
    where s.id = p_slip
      and (
        s.placed_by = auth.uid()
        or app.managed_at(s.entry_id, s.placed_at)
        or (
          app.can_see_slip(s.id)
          and not exists (select 1 from public.slip_legs l where l.slip_id = s.id and not app.can_see_leg(s.id, l.game_id))
        )
      )
  )
$$;

-- ---------------------------------------------------------------- lines

-- The line the league is offering right now for each game, market and side:
-- an admin override if the market has one, else the highest-priority book that
-- offered both sides in the latest good pull.
create view public.current_lines with (security_invoker = true) as
with last_pull as (
  select max(at) as at from public.line_pulls where kind = 'lines' and ok
),
books as (
  select b.book, b.ord from public.league_settings s, unnest(s.books) with ordinality as b(book, ord)
),
offered as (
  select bl.game_id, bl.market, bl.book, min(bk.ord) as ord
  from public.book_lines bl
  join books bk on bk.book = bl.book
  join last_pull lp on bl.seen_at >= lp.at
  group by bl.game_id, bl.market, bl.book
  having count(*) = 2
),
chosen as (
  select distinct on (game_id, market) game_id, market, book from offered order by game_id, market, ord
)
select bl.game_id, bl.market, bl.side, bl.point, bl.price, bl.book as source, bl.seen_at as as_of, false as is_override
from public.book_lines bl
join chosen c on c.game_id = bl.game_id and c.market = bl.market and c.book = bl.book
where not exists (select 1 from public.line_overrides o where o.game_id = bl.game_id and o.market = bl.market)
union all
select o.game_id, o.market, o.side, o.point, o.price, 'override', o.set_at, true
from public.line_overrides o
where o.offered;

create or replace function app.book_lines_history() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' or new.point is distinct from old.point or new.price <> old.price then
    insert into public.line_history (game_id, market, side, book, point, price, at)
    values (new.game_id, new.market, new.side, new.book, new.point, new.price, new.seen_at);
  end if;
  return null;
end $$;

create trigger book_lines_history after insert or update on public.book_lines
for each row execute function app.book_lines_history();

-- Stores one Odds API lines pull, already normalized by the Edge Function:
-- [{id, commenceTime, homeTeam, awayTeam, books: [{book, outcomes: [{market, side, point, price}]}]}]
--
-- Pulls are stored one at a time, each stamped after the one before, so a slow pull
-- can't overwrite a newer one and take lines off the board.
--
-- A game's kickoff follows the feed only while the game is scheduled and hasn't
-- started by the database clock. Once it has started, or an admin has postponed it,
-- the kickoff stays put: moving it later would reopen betting and hide picks that
-- members have already seen. A game with bets on it never changes week.
create or replace function public.ingest_lines_internal(
  p_trigger text, p_events jsonb, p_credits_used int, p_credits_remaining int
) returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_at timestamptz;
  ev jsonb;
  bk jsonb;
  oc jsonb;
  v_home text;
  v_away text;
  v_kick timestamptz;
  v_week int;
  v_game public.games%rowtype;
  v_n int := 0;
begin
  perform pg_advisory_xact_lock(hashtext('ingest_lines'));
  v_at := clock_timestamp();
  -- Lock the pull's games in id order, the order placing a bet uses, so the two can't deadlock.
  perform 1 from public.games where odds_api_id in (select e ->> 'id' from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) e)
   order by id for update;
  for ev in select * from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) loop
    select abbr into v_home from public.teams where name = ev ->> 'homeTeam';
    select abbr into v_away from public.teams where name = ev ->> 'awayTeam';
    v_kick := (ev ->> 'commenceTime')::timestamptz;
    v_week := app.week_for(v_kick);
    -- Skip anything that isn't a league game (e.g. the Pro Bowl) or is outside the season.
    continue when v_home is null or v_away is null or v_week is null;

    select * into v_game from public.games where odds_api_id = ev ->> 'id' for update;
    if not found then
      insert into public.games (odds_api_id, week, kickoff_at, home_team, away_team, feed_commence, feed_commence_firm)
      values (ev ->> 'id', v_week, v_kick, v_home, v_away, v_kick, v_kick > v_at)
      returning * into v_game;
    else
      -- The feed's own start time closes betting when it passes (see place_slip_internal
      -- and games.feed_commence_firm). A firm time that has passed stays, so a later reading
      -- can't reopen betting on a game that hasn't started here; a time first read after
      -- it had passed is replaced by the next reading that disagrees, or made firm by the
      -- next one that agrees.
      if v_game.feed_commence is not distinct from v_kick then
        if not v_game.feed_commence_firm then
          update public.games set feed_commence_firm = true where id = v_game.id;
        end if;
      elsif not (v_game.status = 'scheduled' and v_game.feed_commence <= v_at and v_game.feed_commence_firm) then
        update public.games set feed_commence = v_kick, feed_commence_firm = v_kick > v_at where id = v_game.id;
      end if;
      if v_game.status = 'scheduled' and v_game.kickoff_at > v_at and v_game.kickoff_at <> v_kick then
        -- A new start time moves the kickoff when two pulls in a row agree on it, so one
        -- bad reading can't show a game's picks early or keep betting open past the real
        -- start. A game due within the hour follows a single reading of an earlier time,
        -- since its start is imminent anyway. A start already in the past is believed
        -- only for a game that was due within the hour; for a game hours away it's a bad
        -- reading (if the game really is under way, its scores close betting on it).
        if (v_game.feed_kickoff is not distinct from v_kick
            or (v_kick < v_game.kickoff_at and v_game.kickoff_at <= v_at + interval '1 hour'))
           and (v_kick > v_at or v_game.kickoff_at <= v_at + interval '1 hour') then
          update public.games
             set kickoff_at = v_kick,
                 feed_kickoff = null,
                 week = case
                   when week_moved or exists (select 1 from public.slip_legs l where l.game_id = v_game.id) then week
                   else v_week
                 end,
                 updated_at = v_at
           where id = v_game.id;
        else
          update public.games set feed_kickoff = v_kick where id = v_game.id;
        end if;
      elsif v_game.feed_kickoff is not null and v_game.kickoff_at = v_kick then
        -- The feed is back to the kickoff the league has.
        update public.games set feed_kickoff = null where id = v_game.id;
      elsif v_game.status = 'postponed' and v_kick is distinct from coalesce(v_game.rescheduled_at, v_game.kickoff_at) then
        -- The kickoff stays put (it decides when picks show); the new time keeps score pulls going.
        update public.games set rescheduled_at = v_kick, updated_at = v_at where id = v_game.id;
      end if;
    end if;

    for bk in select * from jsonb_array_elements(coalesce(ev -> 'books', '[]'::jsonb)) loop
      for oc in select * from jsonb_array_elements(coalesce(bk -> 'outcomes', '[]'::jsonb)) loop
        insert into public.book_lines as bl (game_id, market, side, book, point, price, seen_at, changed_at)
        values (v_game.id, oc ->> 'market', oc ->> 'side', bk ->> 'book', (oc ->> 'point')::numeric, (oc ->> 'price')::int, v_at, v_at)
        on conflict (game_id, market, side, book) do update
          set seen_at = excluded.seen_at,
              changed_at = case when bl.point is distinct from excluded.point or bl.price <> excluded.price
                                then excluded.changed_at else bl.changed_at end,
              point = excluded.point,
              price = excluded.price;
      end loop;
    end loop;
    v_n := v_n + 1;
  end loop;

  insert into public.line_pulls (at, kind, trigger, ok, events, credits_used, credits_remaining)
  values (v_at, 'lines', p_trigger, true, v_n, p_credits_used, p_credits_remaining);
  return v_n;
end $$;

-- A bet asks for fresh lines when they're older than p_min_seconds. Only one bet per
-- p_min_seconds gets to pull, however many arrive at once; one member's bets get at most
-- one refresh per bet_refresh_member_minutes and bet_refresh_member_daily_cap a day; and
-- bets in all get at most bet_refresh_daily_cap a day. So neither a burst of bets nor a
-- script of slips refused afterwards can run the Odds API credits down. Returns
-- 'claimed' to the bet that should pull; otherwise 'recent' (a refresh just ran or is
-- running) or 'limit' (a member's or the day's limit is used up).
create or replace function public.claim_bet_refresh_internal(p_min_seconds int, p_user uuid default null) returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_now timestamptz; v_set public.league_settings%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('bet_refresh'));
  v_now := clock_timestamp();
  select * into v_set from public.league_settings;
  if v_set.bet_refresh_claimed_at >= v_now - make_interval(secs => greatest(coalesce(p_min_seconds, 120), 30)) then return 'recent'; end if;
  if p_user is not null and (
       exists (select 1 from public.bet_refreshes where user_id = p_user and at > v_now - make_interval(mins => v_set.bet_refresh_member_minutes))
    or (select count(*) from public.bet_refreshes where user_id = p_user and at > v_now - interval '24 hours') >= v_set.bet_refresh_member_daily_cap
  ) then
    return 'limit';
  end if;
  if (select count(*) from public.bet_refreshes where at > v_now - interval '24 hours') >= v_set.bet_refresh_daily_cap then return 'limit'; end if;
  update public.league_settings set bet_refresh_claimed_at = v_now;
  insert into public.bet_refreshes (user_id, at) values (p_user, v_now);
  return 'claimed';
end $$;

-- How many games need scores: started in the last 3 days and not final or void. A game
-- counts from its kickoff or from the feed's own start time, so one the feed shows under
-- way gets score pulls (and closes) even while its kickoff here is later, and one the
-- feed moved later is still checked when it's played. A postponed game counts from the
-- feed's new start time, if it has one.
create or replace function public.games_awaiting_scores_internal(p_now timestamptz) returns int
language sql stable security definer set search_path = public, pg_temp
as $$
  select count(*)::int from public.games g
  where g.status in ('scheduled', 'live', 'postponed')
    and case
      when g.status = 'postponed' then coalesce(g.rescheduled_at, g.kickoff_at) between p_now - interval '3 days' and p_now
      else g.kickoff_at between p_now - interval '3 days' and p_now
        or g.feed_commence between p_now - interval '3 days' and p_now
    end
$$;

-- Records a failed (or skipped) pull so the site can show it and the guard can see it.
create or replace function public.record_pull_internal(
  p_kind text, p_trigger text, p_ok boolean, p_error text, p_credits_used int, p_credits_remaining int
) returns void
language sql security definer set search_path = public, pg_temp
as $$
  insert into public.line_pulls (kind, trigger, ok, error, credits_used, credits_remaining)
  values (p_kind, p_trigger, p_ok, p_error, p_credits_used, p_credits_remaining)
$$;

-- Stores an Odds API scores pull: [{id, completed, homeScore, awayScore}].
-- A game an admin voided stays void. A final score is never changed here; a
-- different score for a final game is logged for the admins instead.
--
-- The feed has to report the same final score on two pulls in a row before a game
-- goes final and its bets are graded, so one bad reading isn't paid out.
-- A game the feed has scores for has started, whatever kickoff the league had for
-- it, so its kickoff is brought forward to now and betting on it closes.
create or replace function public.ingest_scores_internal(
  p_trigger text, p_scores jsonb, p_credits_used int, p_credits_remaining int
) returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  sc jsonb;
  g public.games%rowtype;
  v_home int;
  v_away int;
  v_now timestamptz := clock_timestamp();
  v_n int := 0;
begin
  perform 1 from public.games where odds_api_id in (select e ->> 'id' from jsonb_array_elements(coalesce(p_scores, '[]'::jsonb)) e)
   order by id for update;
  for sc in select * from jsonb_array_elements(coalesce(p_scores, '[]'::jsonb)) loop
    select * into g from public.games where odds_api_id = sc ->> 'id' for update;
    continue when not found or g.status = 'void';
    -- Scores for a game that both the league and the feed have more than an hour from its
    -- start are a bad reading. (If either says it's near or under way, they count.)
    continue when g.kickoff_at > v_now + interval '1 hour' and coalesce(g.feed_commence, g.kickoff_at) > v_now + interval '1 hour';
    continue when jsonb_typeof(sc -> 'homeScore') is distinct from 'number' or jsonb_typeof(sc -> 'awayScore') is distinct from 'number';
    v_home := (sc ->> 'homeScore')::int;
    v_away := (sc ->> 'awayScore')::int;
    continue when v_home < 0 or v_away < 0;
    if g.status = 'final' then
      if (g.home_score, g.away_score) is distinct from (v_home, v_away)
         and not exists (
           select 1 from public.audit_log
           where action = 'score_mismatch' and target_id = g.id::text
             and after = jsonb_build_object('home', v_home, 'away', v_away)
         ) then
        perform app.audit(null, 'score_mismatch', 'game', g.id::text,
          jsonb_build_object('home', g.home_score, 'away', g.away_score),
          jsonb_build_object('home', v_home, 'away', v_away),
          'The score feed disagrees with a final score. An admin should check it.');
      end if;
      continue;
    end if;
    if coalesce((sc ->> 'completed')::boolean, false)
       and (g.feed_final_home, g.feed_final_away) is not distinct from (v_home, v_away) then
      update public.games set status = 'final', home_score = v_home, away_score = v_away,
        feed_final_home = null, feed_final_away = null,
        kickoff_at = least(kickoff_at, v_now), final_at = v_now, updated_at = v_now
       where id = g.id;
    else
      update public.games set status = 'live', home_score = v_home, away_score = v_away,
        feed_final_home = case when coalesce((sc ->> 'completed')::boolean, false) then v_home end,
        feed_final_away = case when coalesce((sc ->> 'completed')::boolean, false) then v_away end,
        kickoff_at = least(kickoff_at, v_now), updated_at = v_now
       where id = g.id;
    end if;
    v_n := v_n + 1;
  end loop;
  insert into public.line_pulls (kind, trigger, ok, events, credits_used, credits_remaining)
  values ('scores', p_trigger, true, v_n, p_credits_used, p_credits_remaining);
  return v_n;
end $$;

-- ---------------------------------------------------------------- bets

-- Places a slip. Called only by the place-slip Edge Function after it has checked
-- the slip against the rule set with the shared rules code. This function enforces
-- what must hold even if that code were wrong: the caller manages the entry, the
-- week is open, no leg's game has started (database clock), each leg matches the
-- league's current line, the lines are fresh, and the stake fits the rules and the
-- entry's available units. The entry row is locked so simultaneous slips can't
-- spend the same units. Times are read after the locks are taken, so a bet that
-- waited on a lock is still checked against kickoff as of when it's recorded.
--
-- p_client_ref comes from the site with each bet: a retry with the same ref returns
-- the bet already placed instead of placing it again.
--
-- p_legs: [{gameId, market, side, point, price}]
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
  v_week public.weeks%rowtype;
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
  perform 1 from public.entries where id = p_entry and status = 'active' for no key update;
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

  select * into v_week from public.weeks where status = 'open';
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

  v_now := clock_timestamp();
  -- A game's betting closes at its kickoff or at the feed's own start time, whichever
  -- comes first (see games.feed_commence).
  if v_doc ->> 'lock' = 'week_first_kickoff' then
    select min(least(kickoff_at, feed_commence)) into v_week_first from public.games where week = v_week.week and status <> 'void';
    if v_week_first <= v_now then raise exception 'week_locked'; end if;
  end if;

  select max(at) into v_last_pull from public.line_pulls where kind = 'lines' and ok;

  -- Lock the slip's games in id order, as the line pulls do, so the two can't deadlock.
  perform 1 from public.games where id in (select (x ->> 'gameId')::uuid from jsonb_array_elements(p_legs) x) order by id for share;

  insert into public.slips (entry_id, placed_by, week, type, teaser_points, stake_cents, quoted_american,
                            potential_payout_cents, leg_count, rule_set_version, placed_at, client_ref)
  values (p_entry, p_user, v_week.week, p_type, p_teaser_points, p_stake_cents, p_quoted_american,
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

-- Balance and manager check for the place-slip Edge Function.
create or replace function public.entry_balance_internal(p_entry uuid, p_user uuid)
returns table (manages boolean, active boolean, available_cents bigint, bank_cents bigint)
language sql stable security definer set search_path = public, pg_temp
as $$
  select app.manages(e.id, p_user), e.status = 'active', app.available_cents(e.id), app.bank_cents(e.id)
  from public.entries e where e.id = p_entry
$$;

-- For the add-member Edge Function: an existing login's id by email.
create or replace function public.user_id_by_email_internal(p_email text) returns uuid
language sql stable security definer set search_path = public, pg_temp
as $$ select id from auth.users where lower(email) = lower(trim(p_email)) $$;

-- A member undoes their own bet within the undo window, before any of its games
-- starts, while its week is still open (so an early close can't be dodged).
create or replace function public.undo_slip(p_slip uuid) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v public.slips%rowtype;
  v_minutes numeric;
  v_now timestamptz;
begin
  -- Lock the entry first, as placing and closing a week do, so an undo can't slip
  -- in while the week's minimum is being worked out.
  perform 1 from public.entries e join public.slips s on s.entry_id = e.id where s.id = p_slip for no key update of e;
  select * into v from public.slips where id = p_slip for update;
  if not found or not app.manages(v.entry_id) then raise exception 'not_found'; end if;
  if v.status <> 'pending' then raise exception 'not_pending'; end if;
  if not exists (select 1 from public.weeks where week = v.week and status = 'open') then raise exception 'week_closed'; end if;
  v_now := clock_timestamp();
  select (document ->> 'undoMinutes')::numeric into v_minutes from public.rule_sets where version = v.rule_set_version;
  if v_now > v.placed_at + make_interval(secs => coalesce(v_minutes, 0) * 60) then raise exception 'undo_window_passed'; end if;
  if app.slip_locks_at(v.id) <= v_now then raise exception 'game_started'; end if;
  update public.slips set status = 'undone', undone_at = v_now where id = p_slip;
  insert into public.ledger (entry_id, amount_cents, kind, slip_id, week, created_by)
  values (v.entry_id, v.stake_cents, 'undo', v.id, v.week, auth.uid());
end $$;

-- Settles a slip with the grade the grading job computed from the slip's own rule set.
-- Returns false if the slip was already settled, or if the grade is stale: the job
-- sends the versions (updated_at) of the games it graded from, and if an admin has
-- changed one since (a corrected score, a void), the slip is left for the next run.
-- The entry is locked first, then the games, then the slip, the order placing a bet
-- uses. (Corrections lock a game, then its slips, and never wait on an entry.)
-- Guards keep a bad grade from paying out more than the slip could ever win.
-- p_leg_results: [{legNo, result}]; p_game_versions: [{gameId, version}]
create or replace function public.settle_slip_internal(
  p_slip uuid, p_result text, p_payout_cents bigint, p_leg_results jsonb, p_game_versions jsonb default null
) returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v public.slips%rowtype;
begin
  -- The entry first, as placing a bet does, so a minimum redone below reads the units
  -- free after any bet being placed right now; then the games, then the slip.
  perform 1 from public.entries e join public.slips s on s.entry_id = e.id where s.id = p_slip for no key update of e;
  perform 1 from public.games g where g.id in (select l.game_id from public.slip_legs l where l.slip_id = p_slip) order by g.id for share;
  if p_game_versions is not null and exists (
    select 1 from public.slip_legs l join public.games g on g.id = l.game_id
    where l.slip_id = p_slip
      and g.updated_at is distinct from (
        select (x ->> 'version')::timestamptz from jsonb_array_elements(p_game_versions) x where x ->> 'gameId' = g.id::text limit 1
      )
  ) then
    return false;
  end if;
  select * into v from public.slips where id = p_slip for update;
  if not found then raise exception 'not_found'; end if;
  if v.status <> 'pending' then return false; end if;
  if p_result not in ('won', 'lost', 'push', 'void') then raise exception 'bad_result'; end if;
  if (p_result = 'lost' and p_payout_cents <> 0)
     or (p_result in ('push', 'void') and p_payout_cents <> v.stake_cents)
     or (p_result = 'won' and (p_payout_cents <= v.stake_cents or p_payout_cents > v.potential_payout_cents)) then
    raise exception 'bad_payout';
  end if;

  update public.slip_legs l set result = r.result
    from jsonb_to_recordset(coalesce(p_leg_results, '[]'::jsonb)) as r("legNo" int, result text)
   where l.slip_id = p_slip and l.leg_no = r."legNo";
  update public.slips set status = p_result, payout_cents = p_payout_cents, settled_at = now() where id = p_slip;
  if p_payout_cents > 0 then
    insert into public.ledger (entry_id, amount_cents, kind, slip_id, week)
    values (v.entry_id, p_payout_cents, case when p_result = 'won' then 'payout' else 'refund' end, v.id, v.week);
  end if;
  perform app.recheck_minimum(v.week, v.entry_id);
  return true;
end $$;

-- ---------------------------------------------------------------- weeks

create or replace function app.snapshot_entry(p_week int, p_entry uuid) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_doc jsonb; v_bank bigint;
begin
  select r.document into v_doc from public.weeks w join public.rule_sets r on r.version = w.rule_set_version where w.week = p_week;
  v_bank := app.bank_cents(p_entry);
  insert into public.week_entry_status (week, entry_id, bank_at_start_cents, required_cents)
  values (p_week, p_entry, v_bank, app.required_cents(v_bank, v_doc))
  on conflict (week, entry_id) do update
    set bank_at_start_cents = excluded.bank_at_start_cents, required_cents = excluded.required_cents;
end $$;

create or replace function app.close_week(p_week int) returns void
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
  select rs.document into v_doc from public.weeks w join public.rule_sets rs on rs.version = w.rule_set_version where w.week = p_week;
  v_deduct := coalesce(v_doc -> 'weeklyMinimum' ->> 'penalty' = 'deduct_shortfall', false);
  -- Lock the week's entries, then every bet of the week, before writing any result: the
  -- order placing, undoing and corrections take them in, so none of them can deadlock
  -- with a close. The share locks also wait for bets being settled right now, so the
  -- sums below see their results.
  perform 1 from public.entries where id in (select entry_id from public.week_entry_status where week = p_week)
   order by id for no key update;
  perform 1 from public.slips where week = p_week order by id for share;
  for r in
    select wes.entry_id, wes.required_cents from public.week_entry_status wes
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
  update public.weeks set status = 'closed', closed_at = now() where week = p_week;
end $$;

-- Redoes an entry's weekly minimum for a week that has already closed, after one of
-- its bets changed in a way that changes what counts as wagered (an admin voiding it;
-- see app.counts_toward_minimum), and posts the difference as its own ledger row. Does
-- nothing for a week that hasn't closed, or when what counts hasn't changed.
-- What the entry owes for the week is its shortfall now, less what was waived at the
-- close for lack of units (that stays waived). Owing more, it pays from the units free
-- now, and whatever it can't pay is waived too ("unpaid"). Owing less, it first cancels
-- that unpaid part, then gets units back. So the result depends only on which bets count,
-- not on the order the changes came in.
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
  select rs.document into v_doc from public.weeks wk join public.rule_sets rs on rs.version = wk.rule_set_version where wk.week = p_week;
  select coalesce(sum(stake_cents), 0) into v_wagered from public.slips
   where entry_id = p_entry and week = p_week and app.counts_toward_minimum(status, void_reason);
  if v_wagered = w.wagered_cents then return; end if;
  v_short := greatest(0, w.required_cents - v_wagered);
  v_unpaid := coalesce(w.unpaid_cents, 0);
  if v_doc -> 'weeklyMinimum' ->> 'penalty' = 'deduct_shortfall' then
    v_owed := greatest(0, v_short - coalesce(w.waived_cents, 0));
    v_have := coalesce(w.deducted_cents, 0) + v_unpaid;
    if v_owed > v_have then
      -- v_delta is what the ledger row moves: negative takes units, positive gives them back.
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

create or replace function app.open_week(p_week int, p_actor uuid) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_version int; e record;
begin
  v_version := app.rule_set_for_week(p_week);
  if v_version is null then raise exception 'no_rule_set'; end if;
  update public.weeks set status = 'open', opened_at = now(), opened_by = p_actor, rule_set_version = v_version
   where week = p_week and status = 'upcoming';
  if not found then raise exception 'week_not_upcoming'; end if;
  for e in select id from public.entries where status = 'active' order by id loop
    perform app.snapshot_entry(p_week, e.id);
  end loop;
end $$;

-- Closes the open week and opens the next one.
-- Automatic (p_force = false): only when every game of the open week is final or void,
-- nothing is pending, and the next week's games are loaded.
-- Admin (p_force = true): closes the open week regardless, e.g. around a postponed game.
-- The admin names the week they expect to close (p_expected_open, null when none is
-- open), so a click on a page loaded before the week changed can't close the new one.
-- A week in which no game has kicked off can't be closed early. An admin can close a
-- week only into a next week whose games are loaded (so betting never stalls with no
-- week open), except at the end of the season (p_end_season), when the week closes
-- and nothing opens. With no week open, only an admin can open the first one.
create or replace function app.advance_week(p_actor uuid, p_force boolean, p_expected_open int default null, p_end_season boolean default false) returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_open int;
  v_next int;
begin
  perform pg_advisory_xact_lock(hashtext('advance_week'));
  select week into v_open from public.weeks where status = 'open';
  if p_force and v_open is distinct from p_expected_open then raise exception 'week_changed'; end if;
  if p_end_season and v_open is null then raise exception 'no_open_week'; end if;
  if v_open is null then
    if not p_force then return null; end if;
    select min(w.week) into v_next from public.weeks w
     where w.status = 'upcoming' and w.ends_at > now()
       and exists (select 1 from public.games g where g.week = w.week);
    if v_next is null then raise exception 'no_week_to_open'; end if;
    update public.weeks set status = 'closed', closed_at = now() where status = 'upcoming' and week < v_next;
  else
    if p_force and not exists (select 1 from public.games where week = v_open and kickoff_at <= clock_timestamp()) then
      raise exception 'week_not_started';
    end if;
    select min(w.week) into v_next from public.weeks w
     where w.week > v_open and w.status = 'upcoming'
       and exists (select 1 from public.games g where g.week = w.week);
    if p_force and v_next is null and not p_end_season then raise exception 'next_week_not_loaded'; end if;
    if p_force and v_next is not null and p_end_season then raise exception 'next_week_loaded'; end if;
    if not p_force and (
         v_next is null
      or exists (select 1 from public.games where week = v_open and status not in ('final', 'void'))
      or exists (select 1 from public.slips where week = v_open and status = 'pending')) then
      return null;
    end if;
    perform app.close_week(v_open);
    if v_next is null then
      perform app.audit(p_actor, 'week_closed', 'week', v_open::text, null, jsonb_build_object('closed', v_open),
        'Closed by an admin: the end of the season');
      return null;
    end if;
  end if;
  perform app.open_week(v_next, p_actor);
  perform app.audit(p_actor, 'week_opened', 'week', v_next::text,
    case when v_open is null then null else jsonb_build_object('closed', v_open) end,
    jsonb_build_object('opened', v_next),
    case when p_force then 'Opened by an admin' else 'The previous week finished' end);
  return v_next;
end $$;

create or replace function public.advance_week_internal() returns int
language sql security definer set search_path = public, pg_temp
as $$ select app.advance_week(null, false) $$;

-- ---------------------------------------------------------------- rules

-- Publishes a new rule-set version. Called by the publish-rules Edge Function after
-- it has checked the document with the shared rules code.
create or replace function public.publish_rule_set_internal(
  p_actor uuid, p_document jsonb, p_effective_week int, p_note text
) returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_version int; v_open int; v_path text;
begin
  if not app.is_admin(p_actor) then raise exception 'admin_only' using errcode = '42501'; end if;
  -- Same lock as opening a week, so a week can't open with rules published a moment later.
  perform pg_advisory_xact_lock(hashtext('advance_week'));
  select week into v_open from public.weeks where status = 'open';
  if p_effective_week is null or p_effective_week <= coalesce(v_open, 0) then raise exception 'effective_week_must_be_future'; end if;
  if not exists (select 1 from public.weeks where week = p_effective_week) then raise exception 'unknown_week'; end if;
  -- A new version starts no earlier than the latest one already scheduled, so the
  -- newest version is always the one in effect from its week on.
  if p_effective_week < (select max(effective_week) from public.rule_sets) then
    raise exception 'effective_week_before_scheduled';
  end if;
  -- The shared rules check already requires all of this. This is the backstop for the
  -- values the database reads itself, where a missing one would switch a check off.
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
  select coalesce(max(version), 0) + 1 into v_version from public.rule_sets;
  insert into public.rule_sets (version, effective_week, document, note, created_by)
  values (v_version, p_effective_week, p_document, coalesce(p_note, ''), p_actor);
  perform app.audit(p_actor, 'rules_published', 'rule_set', v_version::text, null,
    jsonb_build_object('version', v_version, 'effectiveWeek', p_effective_week, 'document', p_document), p_note);
  return v_version;
end $$;

-- ---------------------------------------------------------------- member functions

create or replace function public.set_display_name(p_name text) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'sign_in_required'; end if;
  if p_name is null or length(trim(p_name)) not between 1 and 40 then raise exception 'bad_name'; end if;
  update public.profiles set display_name = trim(p_name) where id = auth.uid();
end $$;

-- The signed-in member's entries with their balances and this week's minimum.
create or replace function public.my_entries()
returns table (
  entry_id uuid, name text, available_cents bigint, pending_cents bigint, bank_cents bigint,
  week int, required_cents bigint, wagered_cents bigint
)
language sql stable security definer set search_path = public, pg_temp
as $$
  select e.id, e.name, app.available_cents(e.id), app.pending_cents(e.id), app.bank_cents(e.id),
         w.week, wes.required_cents,
         (select coalesce(sum(s.stake_cents), 0)::bigint from public.slips s
           where s.entry_id = e.id and s.week = w.week and app.counts_toward_minimum(s.status, s.void_reason))
  from public.entries e
  join public.entry_managers m on m.entry_id = e.id and m.user_id = auth.uid()
  left join public.weeks w on w.status = 'open'
  left join public.week_entry_status wes on wes.week = w.week and wes.entry_id = e.id
  where e.status = 'active'
  order by e.name
$$;

-- League standings. Bank never reveals a hidden bet (placing one doesn't change it).
-- For entries the viewer doesn't manage, at-risk and this week's wagering count only
-- bets already revealed, so hidden picks stay hidden.
-- With p_week, the period columns cover that week's bets, whenever they settled, and
-- that week's minimum and adjustments. With p_from/p_to, they cover bets settled in
-- [p_from, p_to). With neither, they cover the season, including totals carried over
-- from Splash.
create or replace function public.standings(
  p_from timestamptz default null, p_to timestamptz default null, p_week int default null
)
returns table (
  entry_id uuid, name text, is_mine boolean,
  bank_cents bigint, season_net_cents bigint, season_winnings_cents bigint,
  wins int, losses int, pushes int, risk_cents bigint, return_cents bigint, net_cents bigint, winnings_cents bigint,
  at_risk_cents bigint, week int, required_cents bigint, wagered_cents bigint
)
language sql stable security definer set search_path = public, pg_temp
as $$
  with ow as (select week from public.weeks where status = 'open'),
  is_season as (select p_from is null and p_to is null and p_week is null as yes),
  settled as (
    select s.entry_id,
      count(*) filter (where s.status = 'won') as w,
      count(*) filter (where s.status = 'lost') as l,
      count(*) filter (where s.status = 'push') as p,
      coalesce(sum(s.stake_cents), 0) as risk,
      coalesce(sum(s.payout_cents), 0) as ret,
      coalesce(sum(s.payout_cents - s.stake_cents) filter (where s.status = 'won'), 0) as winnings
    from public.slips s
    where s.status in ('won', 'lost', 'push')
      and (p_week is null or s.week = p_week)
      and (p_from is null or s.settled_at >= p_from)
      and (p_to is null or s.settled_at < p_to)
    group by s.entry_id
  ),
  season_settled as (
    select s.entry_id, coalesce(sum(s.payout_cents - s.stake_cents) filter (where s.status = 'won'), 0) as winnings
    from public.slips s where s.status = 'won' group by s.entry_id
  ),
  other as (
    select l.entry_id, coalesce(sum(l.amount_cents), 0) as amt
    from public.ledger l
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
    from public.slips s where s.status = 'pending' group by s.entry_id
  ),
  wk as (
    select s.entry_id,
      sum(s.stake_cents) as all_wagered,
      coalesce(sum(s.stake_cents) filter (where app.slip_reveal_at(s.id) <= now()), 0) as revealed_wagered
    from public.slips s join ow on s.week = ow.week
    where app.counts_toward_minimum(s.status, s.void_reason)
    group by s.entry_id
  )
  select
    e.id, e.name, app.manages(e.id) as is_mine,
    app.bank_cents(e.id),
    app.bank_cents(e.id) - e.starting_bank_cents,
    coalesce(b.winnings_cents, 0) + coalesce(ss.winnings, 0),
    (coalesce(st.w, 0) + case when (select yes from is_season) then coalesce(b.wins, 0) else 0 end)::int,
    (coalesce(st.l, 0) + case when (select yes from is_season) then coalesce(b.losses, 0) else 0 end)::int,
    (coalesce(st.p, 0) + case when (select yes from is_season) then coalesce(b.pushes, 0) else 0 end)::int,
    (coalesce(st.risk, 0) + case when (select yes from is_season) then coalesce(b.risk_cents, 0) else 0 end)::bigint,
    (coalesce(st.ret, 0) + case when (select yes from is_season) then coalesce(b.return_cents, 0) else 0 end)::bigint,
    case when (select yes from is_season)
      then app.bank_cents(e.id) - e.starting_bank_cents
      else (coalesce(st.ret, 0) - coalesce(st.risk, 0) + coalesce(o.amt, 0))
    end::bigint,
    (coalesce(st.winnings, 0) + case when (select yes from is_season) then coalesce(b.winnings_cents, 0) else 0 end)::bigint,
    (case when app.manages(e.id) then coalesce(pd.all_pending, 0) else coalesce(pd.revealed_pending, 0) end)::bigint,
    (select week from ow),
    wes.required_cents,
    (case when app.manages(e.id) then coalesce(wk.all_wagered, 0) else coalesce(wk.revealed_wagered, 0) end)::bigint
  from public.entries e
  left join settled st on st.entry_id = e.id
  left join season_settled ss on ss.entry_id = e.id
  left join public.entry_baselines b on b.entry_id = e.id
  left join other o on o.entry_id = e.id
  left join pend pd on pd.entry_id = e.id
  left join wk on wk.entry_id = e.id
  left join public.week_entry_status wes on wes.entry_id = e.id and wes.week = (select week from ow)
  where e.status = 'active'
$$;

-- Combined odds and payout for the given slips, for the ones the caller may see:
-- their own entries' slips, and other slips once every leg is revealed.
create or replace function public.slip_quotes(p_ids uuid[])
returns table (slip_id uuid, quoted_american bigint, potential_payout_cents bigint)
language sql stable security definer set search_path = public, pg_temp
as $$
  select s.id, s.quoted_american, s.potential_payout_cents
  from public.slips s
  where auth.uid() is not null
    and s.id = any(p_ids[1:500])
    and app.can_see_quote(s.id)
$$;

-- Picks other members have placed that aren't revealed yet: who and when, nothing else.
create or replace function public.hidden_activity(p_limit int default 50)
returns table (entry_id uuid, name text, placed_at timestamptz)
language sql stable security definer set search_path = public, pg_temp
as $$
  select s.entry_id, e.name, s.placed_at
  from public.slips s join public.entries e on e.id = s.entry_id
  where auth.uid() is not null
    and s.status = 'pending'
    and not app.manages(s.entry_id)
    and app.slip_reveal_at(s.id) > now()
  order by s.placed_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
$$;

-- ---------------------------------------------------------------- admin functions

-- Closes the open week early and opens the next one. p_expected_open is the week the
-- admin's page shows as open (null if none), checked so a stale page can't close the
-- wrong week. Returns the week opened. Refuses (next_week_not_loaded) if no later week
-- has games yet; at the end of the season use admin_close_season.
create or replace function public.admin_open_next_week(p_expected_open int, p_reason text default null) returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_actor uuid := app.require_admin(); v int;
begin
  v := app.advance_week(v_actor, true, p_expected_open);
  if nullif(trim(p_reason), '') is not null then
    perform app.audit(v_actor, 'week_opened_note', 'week', coalesce(v, p_expected_open)::text, null, null, trim(p_reason));
  end if;
  return v;
end $$;

create or replace function public.admin_add_entry(p_name text, p_starting_bank_cents bigint default 0) returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_actor uuid := app.require_admin(); v_id uuid; v_week int;
begin
  if coalesce(p_starting_bank_cents, 0) < 0 then raise exception 'bad_amount'; end if;
  insert into public.entries (name, starting_bank_cents) values (trim(p_name), coalesce(p_starting_bank_cents, 0)) returning id into v_id;
  if p_starting_bank_cents > 0 then
    insert into public.ledger (entry_id, amount_cents, kind, note, created_by)
    values (v_id, p_starting_bank_cents, 'opening', 'Starting bank', v_actor);
  end if;
  select week into v_week from public.weeks where status = 'open';
  if v_week is not null then perform app.snapshot_entry(v_week, v_id); end if;
  perform app.audit(v_actor, 'entry_added', 'entry', v_id::text, null,
    jsonb_build_object('name', trim(p_name), 'startingBankCents', coalesce(p_starting_bank_cents, 0)), null);
  return v_id;
end $$;

-- Closes the season's last week (applying its minimum) when no later week has games.
create or replace function public.admin_close_season(p_expected_open int, p_reason text default null) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_actor uuid := app.require_admin();
begin
  perform app.advance_week(v_actor, true, p_expected_open, true);
  if nullif(trim(p_reason), '') is not null then
    perform app.audit(v_actor, 'week_opened_note', 'week', p_expected_open::text, null, null, trim(p_reason));
  end if;
end $$;

-- Brings an entry over from Splash: its bank, plus record and totals for the season standings.
-- Only for an entry with no bets on this site yet.
create or replace function public.admin_import_splash(
  p_entry uuid, p_bank_cents bigint, p_net_cents bigint,
  p_wins int, p_losses int, p_pushes int,
  p_risk_cents bigint, p_return_cents bigint, p_winnings_cents bigint, p_note text
) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_actor uuid := app.require_admin();
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
    values (p_entry, v_delta, 'import', coalesce(nullif(trim(p_note), ''), 'Splash import'), v_actor);
  end if;
  update public.entries set starting_bank_cents = p_bank_cents - coalesce(p_net_cents, 0) where id = p_entry;
  insert into public.entry_baselines (entry_id, wins, losses, pushes, risk_cents, return_cents, winnings_cents, note)
  values (p_entry, coalesce(p_wins, 0), coalesce(p_losses, 0), coalesce(p_pushes, 0), coalesce(p_risk_cents, 0),
          coalesce(p_return_cents, 0), coalesce(p_winnings_cents, 0), coalesce(p_note, ''))
  on conflict (entry_id) do update set wins = excluded.wins, losses = excluded.losses, pushes = excluded.pushes,
    risk_cents = excluded.risk_cents, return_cents = excluded.return_cents, winnings_cents = excluded.winnings_cents,
    note = excluded.note, imported_at = now();
  select week into v_week from public.weeks where status = 'open';
  if v_week is not null then perform app.snapshot_entry(v_week, p_entry); end if;
  perform app.audit(v_actor, 'splash_import', 'entry', p_entry::text, v_before,
    jsonb_build_object('bankCents', p_bank_cents, 'netCents', p_net_cents, 'wins', p_wins, 'losses', p_losses,
      'pushes', p_pushes, 'riskCents', p_risk_cents, 'returnCents', p_return_cents, 'winningsCents', p_winnings_cents),
    p_note);
end $$;

-- Adds or removes units. The log records the bank, which every member sees anyway,
-- not the available units, which would show how much is riding on hidden bets.
create or replace function public.admin_adjust_bank(p_entry uuid, p_amount_cents bigint, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_actor uuid := app.require_admin(); v_reason text := app.require_reason(p_reason); v_bank bigint;
begin
  perform 1 from public.entries where id = p_entry for no key update;
  if not found then raise exception 'not_found'; end if;
  if p_amount_cents is null or p_amount_cents = 0 then raise exception 'bad_amount'; end if;
  if app.available_cents(p_entry) + p_amount_cents < 0 then raise exception 'insufficient_units'; end if;
  v_bank := app.bank_cents(p_entry);
  insert into public.ledger (entry_id, amount_cents, kind, week, note, created_by)
  values (p_entry, p_amount_cents, 'adjustment', (select week from public.weeks where status = 'open'), v_reason, v_actor);
  perform app.audit(v_actor, 'bank_adjusted', 'entry', p_entry::text,
    jsonb_build_object('bankCents', v_bank), jsonb_build_object('bankCents', v_bank + p_amount_cents, 'amountCents', p_amount_cents),
    v_reason);
end $$;

-- Adds or removes an entry manager. The log names the member and the entry, so an
-- admin making themselves a manager is plain to everyone.
create or replace function public.admin_set_manager(p_entry uuid, p_user uuid, p_add boolean) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_actor uuid := app.require_admin();
begin
  if not exists (select 1 from public.entries where id = p_entry) then raise exception 'not_found'; end if;
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'not_found'; end if;
  -- An admin joining someone else's entry would see its bets from then on, so another
  -- admin has to do it; and while the entry has bets riding, no admin can join it alone
  -- or take away its last manager (the first step of removing a manager, adding
  -- yourself, and putting them back).
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
    insert into public.entry_managers (entry_id, user_id) values (p_entry, p_user) on conflict do nothing;
  else
    delete from public.entry_managers where entry_id = p_entry and user_id = p_user;
  end if;
  perform app.audit(v_actor, case when p_add then 'manager_added' else 'manager_removed' end, 'entry', p_entry::text,
    null, jsonb_build_object('userId', p_user,
      'member', (select display_name from public.profiles where id = p_user),
      'entry', (select name from public.entries where id = p_entry)), null);
end $$;

create or replace function public.admin_set_admin(p_user uuid, p_is_admin boolean) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_actor uuid := app.require_admin();
begin
  if not p_is_admin and (select count(*) from public.profiles where is_admin and id <> p_user) = 0 then
    raise exception 'last_admin';
  end if;
  update public.profiles set is_admin = p_is_admin where id = p_user;
  if not found then raise exception 'not_found'; end if;
  perform app.audit(v_actor, case when p_is_admin then 'admin_granted' else 'admin_removed' end, 'profile', p_user::text, null, null, null);
end $$;

-- Sets the league's line for one market of a game, both sides at once.
-- Side a is home (spread, moneyline) or over (total); side b is away or under.
create or replace function public.admin_set_line(
  p_game uuid, p_market text, p_point_a numeric, p_price_a int, p_point_b numeric, p_price_b int,
  p_offered boolean, p_reason text
) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_actor uuid := app.require_admin();
  v_reason text := app.require_reason(p_reason);
  v_game public.games%rowtype;
  v_before jsonb;
begin
  select * into v_game from public.games where id = p_game for update;
  if not found then raise exception 'not_found'; end if;
  if v_game.status <> 'scheduled' or v_game.kickoff_at <= now() then raise exception 'game_started'; end if;
  if p_market = 'spread' and (p_point_a is null or p_point_b is null or p_point_a + p_point_b <> 0) then raise exception 'spread_points_must_mirror'; end if;
  if p_market = 'total' and (p_point_a is null or p_point_a <> p_point_b or p_point_a <= 0) then raise exception 'total_points_must_match'; end if;
  if p_market = 'moneyline' and (p_point_a is not null or p_point_b is not null) then raise exception 'moneyline_has_no_point'; end if;
  if p_market not in ('spread', 'total', 'moneyline') then raise exception 'bad_market'; end if;
  if p_price_a is null or p_price_b is null or abs(p_price_a) not between 100 and 100000 or abs(p_price_b) not between 100 and 100000 then
    raise exception 'bad_price';
  end if;
  if (p_point_a is not null and p_point_a * 2 <> round(p_point_a * 2)) or (p_point_b is not null and p_point_b * 2 <> round(p_point_b * 2)) then
    raise exception 'bad_point';
  end if;
  select jsonb_agg(to_jsonb(o)) into v_before from public.line_overrides o where o.game_id = p_game and o.market = p_market;
  delete from public.line_overrides where game_id = p_game and market = p_market;
  insert into public.line_overrides (game_id, market, side, point, price, offered, reason, set_by) values
    (p_game, p_market, case when p_market = 'total' then 'over' else 'home' end, p_point_a, p_price_a, coalesce(p_offered, true), v_reason, v_actor),
    (p_game, p_market, case when p_market = 'total' then 'under' else 'away' end, p_point_b, p_price_b, coalesce(p_offered, true), v_reason, v_actor);
  perform app.audit(v_actor, 'line_set', 'game', p_game::text, v_before,
    jsonb_build_object('market', p_market, 'a', jsonb_build_object('point', p_point_a, 'price', p_price_a),
      'b', jsonb_build_object('point', p_point_b, 'price', p_price_b), 'offered', coalesce(p_offered, true)), v_reason);
end $$;

create or replace function public.admin_clear_line(p_game uuid, p_market text, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_actor uuid := app.require_admin(); v_reason text := app.require_reason(p_reason); v_before jsonb;
begin
  select jsonb_agg(to_jsonb(o)) into v_before from public.line_overrides o where o.game_id = p_game and o.market = p_market;
  delete from public.line_overrides where game_id = p_game and market = p_market;
  perform app.audit(v_actor, 'line_cleared', 'game', p_game::text, v_before, jsonb_build_object('market', p_market), v_reason);
end $$;

-- Reopens the graded bets on a game whose result changed (a corrected score, or a
-- final game voided), so the grading job grades them again. Each payout is taken
-- back with a ledger row first. Bets an admin voided stay void.
create or replace function app.reopen_graded(p_game uuid, p_actor uuid, p_reason text) returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.slips%rowtype; v_n int := 0;
begin
  perform set_config('app.reopening', 'on', true);
  -- Lock every slip first, in id order, then the weekly minimums they touch, in
  -- (week, entry) order, so two corrections (or a correction and a week closing) take
  -- their locks in the same order and can't deadlock.
  perform 1 from public.slips s
   where s.id in (select l.slip_id from public.slip_legs l where l.game_id = p_game)
   order by s.id for update;
  perform 1 from public.week_entry_status w
   where (w.week, w.entry_id) in (
     select s.week, s.entry_id from public.slips s
     where s.id in (select l.slip_id from public.slip_legs l where l.game_id = p_game))
   order by w.week, w.entry_id for update;
  for r in
    select s.* from public.slips s
    where s.id in (select l.slip_id from public.slip_legs l where l.game_id = p_game)
      and (s.status in ('won', 'lost', 'push') or (s.status = 'void' and s.void_reason is null))
    order by s.id
  loop
    if coalesce(r.payout_cents, 0) > 0 then
      insert into public.ledger (entry_id, amount_cents, kind, slip_id, week, note, created_by)
      values (r.entry_id, -r.payout_cents, 'regrade_reversal', r.id, r.week, p_reason, p_actor);
    end if;
    update public.slip_legs set result = 'pending' where slip_id = r.id;
    update public.slips set status = 'pending', payout_cents = null, settled_at = null where id = r.id;
    perform app.recheck_minimum(r.week, r.entry_id);
    v_n := v_n + 1;
  end loop;
  perform set_config('app.reopening', 'off', true);
  return v_n;
end $$;

-- Postpone, reschedule, restore or void a game. Voided games grade every leg on them as void.
-- Betting reopens only on a game that hasn't started, and a kickoff is never set in
-- the past, moved once it has passed, or (once its week is open) moved earlier: any of
-- those would show or hide picks at the wrong time.
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
    -- Moving a kickoff earlier shows its picks earlier, so once a game's week has
    -- opened its kickoff only moves later. Real schedule changes come in from the feed;
    -- to stop betting on a game right away, mark it postponed.
    if p_kickoff_at < g.kickoff_at and (select status from public.weeks where week = g.week) <> 'upcoming' then
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

-- Enters a final score by hand: when the score feed fails, or to correct a final score
-- (including one on a game voided by mistake). A correction reopens the game's graded
-- bets, and the grading job grades them again within minutes. Entering the same final
-- score again regrades the game's bets without changing it.
create or replace function public.admin_set_final_score(p_game uuid, p_home int, p_away int, p_reason text) returns void
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
  if g.kickoff_at > v_now then raise exception 'game_not_started'; end if;
  if p_home is null or p_away is null or p_home < 0 or p_away < 0 then raise exception 'bad_score'; end if;
  if g.status in ('final', 'void') then
    v_reopened := app.reopen_graded(p_game, v_actor, v_reason);
  end if;
  update public.games set status = 'final', home_score = p_home, away_score = p_away,
    feed_final_home = null, feed_final_away = null, final_at = v_now, updated_at = v_now
   where id = p_game;
  perform app.audit(v_actor,
    case
      when g.status = 'final' and g.home_score = p_home and g.away_score = p_away then 'bets_regraded'
      when g.status in ('final', 'void') then 'score_corrected'
      else 'score_set'
    end, 'game', p_game::text,
    jsonb_build_object('status', g.status, 'home', g.home_score, 'away', g.away_score),
    jsonb_build_object('status', 'final', 'home', p_home, 'away', p_away, 'betsRegraded', v_reopened), v_reason);
end $$;

-- Moves a game to another week. Only a game in a week that hasn't opened can move, so
-- it can't have bets, and the answer never tells an admin where hidden bets are.
create or replace function public.admin_move_game(p_game uuid, p_week int, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_actor uuid := app.require_admin(); v_reason text := app.require_reason(p_reason); v_old int;
begin
  select week into v_old from public.games where id = p_game for update;
  if not found then raise exception 'not_found'; end if;
  if (select status from public.weeks where week = v_old) <> 'upcoming' then raise exception 'week_already_open'; end if;
  if exists (select 1 from public.slip_legs where game_id = p_game) then raise exception 'game_has_bets'; end if;
  if not exists (select 1 from public.weeks where week = p_week and status <> 'closed') then raise exception 'unknown_week'; end if;
  update public.games set week = p_week, week_moved = true, updated_at = now() where id = p_game;
  perform app.audit(v_actor, 'game_moved', 'game', p_game::text, jsonb_build_object('week', v_old), jsonb_build_object('week', p_week), v_reason);
end $$;

-- Voids a bet: the stake comes back and any winnings paid on it are taken back.
-- The audit row records the entry, never the picks, and the stake only if the bet
-- is already revealed.
create or replace function public.admin_void_slip(p_slip uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_actor uuid := app.require_admin(); v_reason text := app.require_reason(p_reason); v public.slips%rowtype; v_shown boolean;
begin
  -- The entry, then the slip's games, then the slip: the order placing and settling use.
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
    jsonb_build_object('status', 'void'), v_reason);
end $$;

-- Recent failed pulls and grading problems, with their (already masked) error text,
-- for the admin screens only. Members can't read line_pulls.error.
create or replace function public.admin_recent_problems(p_limit int default 10)
returns table (at timestamptz, kind text, trigger text, error text)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  perform app.require_admin();
  return query
    select * from (
      select lp.at, lp.kind, lp.trigger, coalesce(lp.error, '') as error
      from public.line_pulls lp
      where not lp.ok and lp.at > now() - interval '3 days'
      union all
      -- A game still live long after kickoff: the feed may have missed its final.
      select g.kickoff_at + interval '5 hours', 'game', 'check',
             format('%s at %s has been live for over 5 hours with no final. Enter its final score.', ta.short_name, th.short_name)
      from public.games g join public.teams th on th.abbr = g.home_team join public.teams ta on ta.abbr = g.away_team
      where g.status = 'live' and g.kickoff_at < now() - interval '5 hours'
      union all
      -- A game that should have started an hour ago (by its kickoff or the feed's start
      -- time) with no score yet: postponed without anyone saying so, or the scores are behind.
      select least(g.kickoff_at, g.feed_commence) + interval '1 hour', 'game', 'check',
             format('%s at %s should have started by now but has no score yet, so betting on it is closed. If it was postponed, mark it postponed; otherwise the score feed may be behind.', ta.short_name, th.short_name)
      from public.games g join public.teams th on th.abbr = g.home_team join public.teams ta on ta.abbr = g.away_team
      where g.status = 'scheduled' and least(g.kickoff_at, g.feed_commence) < now() - interval '1 hour'
      union all
      -- A postponed game the score pulls have stopped checking.
      select coalesce(g.rescheduled_at, g.kickoff_at) + interval '3 days', 'game', 'check',
             format('%s at %s was postponed and the feed has stopped checking it. Enter its final score, or void it.', ta.short_name, th.short_name)
      from public.games g join public.teams th on th.abbr = g.home_team join public.teams ta on ta.abbr = g.away_team
      where g.status = 'postponed' and coalesce(g.rescheduled_at, g.kickoff_at) < now() - interval '3 days'
    ) x
    order by x.at desc
    limit least(greatest(coalesce(p_limit, 10), 1), 50);
end $$;

-- Members and their emails, for the admin screens only.
create or replace function public.admin_list_users()
returns table (user_id uuid, email text, display_name text, is_admin boolean, entry_names text[])
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  perform app.require_admin();
  return query
    select p.id, u.email::text, p.display_name, p.is_admin,
           coalesce(array_agg(e.name order by e.name) filter (where e.id is not null), '{}')
    from public.profiles p
    join auth.users u on u.id = p.id
    left join public.entry_managers m on m.user_id = p.id
    left join public.entries e on e.id = m.entry_id
    group by p.id, u.email, p.display_name, p.is_admin
    order by p.display_name;
end $$;

-- ---------------------------------------------------------------- accounts

create or replace function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  -- Display names are public, so never default to part of the email address.
  insert into public.profiles (id, display_name)
  values (new.id, left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), 'Member'), 40))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
for each row execute function app.handle_new_user();

-- Makes the first admin. Run once from the SQL editor: select app.bootstrap_admin('you@example.com');
create or replace function app.bootstrap_admin(p_email text) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v uuid;
begin
  select id into v from auth.users where lower(email) = lower(p_email);
  if v is null then raise exception 'no user with that email'; end if;
  update public.profiles set is_admin = true where id = v;
  perform app.audit(null, 'admin_granted', 'profile', v::text, null, null, 'Bootstrap admin');
end $$;

-- ---------------------------------------------------------------- guards

create or replace function app.forbid_change() returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;

create trigger ledger_append_only before update or delete on public.ledger
for each row execute function app.forbid_change();
create trigger audit_append_only before update or delete on public.audit_log
for each row execute function app.forbid_change();
create trigger rule_sets_append_only before update or delete on public.rule_sets
for each row execute function app.forbid_change();

create or replace function app.rule_sets_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v int;
begin
  select week into v from public.weeks where status = 'open';
  if v is not null and new.effective_week <= v then
    raise exception 'rules can only change from a future week';
  end if;
  return new;
end $$;
create trigger rule_sets_future_only before insert on public.rule_sets
for each row execute function app.rule_sets_guard();

create or replace function app.weeks_guard() returns trigger
language plpgsql
as $$
begin
  if old.status <> 'upcoming' and new.rule_set_version is distinct from old.rule_set_version then
    raise exception 'a week''s rules are fixed once it opens';
  end if;
  if old.status = 'closed' and new.status <> 'closed' then
    raise exception 'a closed week stays closed';
  end if;
  return new;
end $$;
create trigger weeks_guard before update on public.weeks
for each row execute function app.weeks_guard();

create or replace function app.slips_guard() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then raise exception 'slips cannot be deleted'; end if;
  if (new.entry_id, new.placed_by, new.week, new.type, new.teaser_points, new.stake_cents, new.quoted_american,
      new.potential_payout_cents, new.leg_count, new.rule_set_version, new.placed_at, new.client_ref)
     is distinct from
     (old.entry_id, old.placed_by, old.week, old.type, old.teaser_points, old.stake_cents, old.quoted_american,
      old.potential_payout_cents, old.leg_count, old.rule_set_version, old.placed_at, old.client_ref) then
    raise exception 'a placed slip cannot be changed';
  end if;
  -- app.reopen_graded sets this while it sends graded bets back to be graded again.
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
create trigger slips_guard before update or delete on public.slips
for each row execute function app.slips_guard();

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
  if (new.slip_id, new.leg_no, new.game_id, new.market, new.side, new.point, new.price, new.teased_point, new.book)
     is distinct from
     (old.slip_id, old.leg_no, old.game_id, old.market, old.side, old.point, old.price, old.teased_point, old.book) then
    raise exception 'a placed leg cannot be changed';
  end if;
  return new;
end $$;
create trigger legs_guard before insert or update or delete on public.slip_legs
for each row execute function app.legs_guard();
