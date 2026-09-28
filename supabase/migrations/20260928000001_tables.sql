-- Core tables for the league. Money is stored as bigint cents (1 unit = 100 cents).
-- All times are timestamptz (UTC); the site shows them in Eastern.

create schema if not exists app;

create table public.league_settings (
  id boolean primary key default true check (id),
  league_name text not null default 'BALTIMORE DEGENERATES',
  season int not null default 2026,
  timezone text not null default 'America/New_York',
  -- Scheduled line pulls run inside this Eastern-time window; bets can trigger a pull any time.
  pull_window_start time not null default '08:00',
  pull_window_end time not null default '01:00',
  pull_every_minutes int not null default 30,
  -- A bet triggers a fresh pull when the last good pull is older than this.
  refresh_on_bet_seconds int not null default 120,
  -- Bets are refused if the last good pull is older than this (unless the line is an admin override).
  max_line_age_minutes int not null default 35,
  -- Pulls stop when the Odds API plan has fewer credits left than this.
  credit_floor int not null default 5000,
  -- Sportsbooks in priority order; the first is the league's line source.
  books text[] not null default array['draftkings', 'fanduel'],
  -- When a bet last claimed a line refresh. Bets share one refresh at a time, so
  -- many bets (or a script) can't run the Odds API credits down.
  bet_refresh_claimed_at timestamptz,
  -- A member's bets can trigger at most one refresh this often, and bets as a whole
  -- at most this many a day; past either, bets use the scheduled pulls' lines.
  bet_refresh_member_minutes int not null default 10,
  bet_refresh_daily_cap int not null default 200
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (length(display_name) between 1 and 40),
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.entries (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(name) between 1 and 40),
  status text not null default 'active' check (status in ('active', 'withdrawn')),
  -- The bank the entry started the season with; season net = bank - this.
  starting_bank_cents bigint not null default 0,
  created_at timestamptz not null default now()
);

create table public.entry_managers (
  entry_id uuid not null references public.entries (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (entry_id, user_id)
);
create index on public.entry_managers (user_id);

create table public.rule_sets (
  version int primary key check (version >= 1),
  effective_week int not null check (effective_week >= 1),
  document jsonb not null,
  note text not null default '',
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

create table public.weeks (
  week int primary key,
  label text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'upcoming' check (status in ('upcoming', 'open', 'closed')),
  opened_at timestamptz,
  opened_by uuid references public.profiles (id),
  closed_at timestamptz,
  rule_set_version int references public.rule_sets (version),
  check (ends_at > starts_at),
  check (status <> 'open' or rule_set_version is not null)
);
-- At most one week is open for betting.
create unique index weeks_one_open on public.weeks ((true)) where status = 'open';

create table public.teams (
  abbr text primary key,
  name text not null unique,
  short_name text not null
);

create table public.games (
  id uuid primary key default gen_random_uuid(),
  odds_api_id text unique,
  week int not null references public.weeks (week),
  -- Set when an admin moves the game; ingestion then leaves its week alone.
  week_moved boolean not null default false,
  kickoff_at timestamptz not null,
  home_team text not null references public.teams (abbr),
  away_team text not null references public.teams (abbr),
  status text not null default 'scheduled' check (status in ('scheduled', 'live', 'final', 'postponed', 'void')),
  home_score int check (home_score >= 0),
  away_score int check (away_score >= 0),
  -- A final score the feed has reported once. The game goes final when the next
  -- pull reports the same score, so one bad reading from the feed isn't graded.
  feed_final_home int,
  feed_final_away int,
  -- The feed's newer start time for a game whose kickoff stays put (one postponed, or
  -- already started). Keeps score pulls going around the new time without moving
  -- kickoff_at, which decides when picks show.
  rescheduled_at timestamptz,
  final_at timestamptz,
  updated_at timestamptz not null default now(),
  check (home_team <> away_team),
  check (status <> 'final' or (home_score is not null and away_score is not null))
);
create index on public.games (week);
create index on public.games (status, kickoff_at);

-- The latest number each sportsbook offered, per game, market and side.
create table public.book_lines (
  game_id uuid not null references public.games (id) on delete cascade,
  market text not null check (market in ('spread', 'total', 'moneyline')),
  side text not null check (side in ('home', 'away', 'over', 'under')),
  book text not null,
  point numeric(5, 1),
  price int not null check (abs(price) >= 100),
  -- The pull that last saw this line; lines not seen in the latest good pull are off the board.
  seen_at timestamptz not null,
  changed_at timestamptz not null,
  primary key (game_id, market, side, book),
  check ((market = 'moneyline') = (point is null)),
  check ((market = 'total') = (side in ('over', 'under')))
);

-- Line refreshes that bets triggered, for the per-member and daily limits.
create table public.bet_refreshes (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles (id) on delete set null,
  at timestamptz not null default now()
);
create index on public.bet_refreshes (at desc);
create index on public.bet_refreshes (user_id, at desc);

-- Every change to a book line, for the record.
create table public.line_history (
  id bigint generated always as identity primary key,
  game_id uuid not null references public.games (id) on delete cascade,
  market text not null,
  side text not null,
  book text not null,
  point numeric(5, 1),
  price int not null,
  at timestamptz not null
);
create index on public.line_history (game_id, market, side, at desc);

-- Admin-set lines. When a game's market has overrides, they replace the book lines.
create table public.line_overrides (
  game_id uuid not null references public.games (id) on delete cascade,
  market text not null check (market in ('spread', 'total', 'moneyline')),
  side text not null check (side in ('home', 'away', 'over', 'under')),
  point numeric(5, 1),
  price int not null check (abs(price) >= 100),
  offered boolean not null default true,
  reason text not null,
  set_by uuid references public.profiles (id),
  set_at timestamptz not null default now(),
  primary key (game_id, market, side),
  check ((market = 'moneyline') = (point is null)),
  check ((market = 'total') = (side in ('over', 'under')))
);

-- One row per Odds API call (lines or scores).
create table public.line_pulls (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  kind text not null default 'lines' check (kind in ('lines', 'scores')),
  trigger text not null check (trigger in ('schedule', 'bet', 'admin')),
  ok boolean not null,
  events int,
  credits_used int,
  credits_remaining int,
  error text
);
create index on public.line_pulls (kind, ok, at desc);

create table public.slips (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.entries (id),
  placed_by uuid not null references public.profiles (id),
  week int not null references public.weeks (week),
  type text not null check (type in ('straight', 'parlay', 'teaser')),
  teaser_points numeric(3, 1),
  stake_cents bigint not null check (stake_cents > 0),
  -- American odds for the whole slip; a long parlay's can pass two billion.
  quoted_american bigint not null,
  potential_payout_cents bigint not null check (potential_payout_cents > stake_cents),
  -- How many legs the slip has, so a partly revealed parlay can say how many are still hidden.
  leg_count int not null check (leg_count >= 1),
  rule_set_version int not null references public.rule_sets (version),
  status text not null default 'pending' check (status in ('pending', 'won', 'lost', 'push', 'void', 'undone')),
  payout_cents bigint check (payout_cents >= 0),
  placed_at timestamptz not null default now(),
  settled_at timestamptz,
  undone_at timestamptz,
  void_reason text,
  -- Sent by the site with each bet, so a retry after a lost response can't place it twice.
  client_ref uuid unique,
  check ((type = 'teaser') = (teaser_points is not null))
);
create index on public.slips (entry_id, status);
create index on public.slips (week, status);

create table public.slip_legs (
  slip_id uuid not null references public.slips (id),
  leg_no int not null check (leg_no >= 1),
  game_id uuid not null references public.games (id),
  market text not null check (market in ('spread', 'total', 'moneyline')),
  side text not null check (side in ('home', 'away', 'over', 'under')),
  point numeric(5, 1),
  price int not null check (abs(price) >= 100),
  teased_point numeric(5, 1),
  book text not null,
  result text not null default 'pending' check (result in ('pending', 'won', 'lost', 'push', 'void')),
  primary key (slip_id, leg_no)
);
create index on public.slip_legs (game_id);
create unique index slip_legs_one_per_pick on public.slip_legs (slip_id, game_id, market, side);

-- Every change to every bank. Available units = sum(amount_cents) for the entry.
create table public.ledger (
  id bigint generated always as identity primary key,
  entry_id uuid not null references public.entries (id),
  amount_cents bigint not null,
  kind text not null check (kind in (
    'opening', 'import', 'stake', 'payout', 'refund', 'undo', 'void_refund', 'void_reversal', 'regrade_reversal',
    'weekly_minimum', 'adjustment'
  )),
  slip_id uuid references public.slips (id),
  week int references public.weeks (week),
  note text not null default '',
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);
create index on public.ledger (entry_id);
create index on public.ledger (slip_id);

-- Each entry's weekly-minimum status, recorded when a week opens and closes.
create table public.week_entry_status (
  week int not null references public.weeks (week),
  entry_id uuid not null references public.entries (id),
  bank_at_start_cents bigint not null,
  required_cents bigint not null,
  wagered_cents bigint,
  shortfall_cents bigint,
  deducted_cents bigint,
  primary key (week, entry_id)
);

-- Totals carried over from Splash at cutover, added to the season standings.
create table public.entry_baselines (
  entry_id uuid primary key references public.entries (id),
  wins int not null default 0,
  losses int not null default 0,
  pushes int not null default 0,
  risk_cents bigint not null default 0,
  return_cents bigint not null default 0,
  winnings_cents bigint not null default 0,
  note text not null default '',
  imported_at timestamptz not null default now()
);

-- Every admin action and rule change. Readable by all members.
create table public.audit_log (
  id bigint generated always as identity primary key,
  actor uuid references public.profiles (id),
  action text not null,
  target_type text,
  target_id text,
  before jsonb,
  after jsonb,
  reason text not null default '',
  created_at timestamptz not null default now()
);
create index on public.audit_log (created_at desc);
