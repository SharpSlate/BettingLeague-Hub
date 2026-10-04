-- The site makes no Odds API calls, and so spends no credits, until its owner says it's
-- ready: while this is off, every pull (the schedule's, a bet's, an undo's, a site
-- admin's) skips. Turned on with one statement (SETUP.md, "Turn on the odds feed").
alter table public.league_settings add column odds_pulls_enabled boolean not null default false;
