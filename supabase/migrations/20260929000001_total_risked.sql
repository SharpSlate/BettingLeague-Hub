-- Standings: the Risk column becomes "Total risked", counting bets still riding as
-- well as graded ones (owner's request, 2026-09-29). Net and Return are unchanged.

-- League standings. Bank never reveals a hidden bet (placing one doesn't change it).
-- For entries the viewer doesn't manage, at-risk, total risked and this week's wagering
-- count only bets already revealed, so hidden picks stay hidden.
-- Total risked (risk_cents) is the stakes of graded bets plus bets still riding: with
-- p_week, that week's; with p_from/p_to, those placed in the range.
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
  period_pend as (
    select s.entry_id,
      sum(s.stake_cents) as all_pending,
      coalesce(sum(s.stake_cents) filter (where app.slip_reveal_at(s.id) <= now()), 0) as revealed_pending
    from public.slips s
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
    (coalesce(st.risk, 0) + case when (select yes from is_season) then coalesce(b.risk_cents, 0) else 0 end
      + case when app.manages(e.id) then coalesce(pp.all_pending, 0) else coalesce(pp.revealed_pending, 0) end)::bigint,
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
  left join period_pend pp on pp.entry_id = e.id
  left join wk on wk.entry_id = e.id
  left join public.week_entry_status wes on wes.entry_id = e.id and wes.week = (select week from ow)
  where e.status = 'active'
$$;
