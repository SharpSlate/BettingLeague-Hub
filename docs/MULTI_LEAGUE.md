# Many leagues on one site

The single-league site ran one league: one rule set history, one open week, one set of admins. This version runs any number of leagues side by side. The betting, pricing, grading and weekly-minimum rules are unchanged (see `DESIGN.md`); what changed is who sees and runs what.

## Shared by every league

| What | Why shared |
|---|---|
| The NFL calendar (week windows), teams, games, scores | They're the same games for everyone. |
| Lines and the Odds API pulls | One pull serves every league, so more leagues cost no more credits. The bet and undo refresh limits are site-wide too. |
| Line overrides, game status, final scores, moving a game | Changing a game changes it for every league, so only **site admins** do it. |

Site admins (`profiles.is_admin`) run the feeds and the games. Being one gives no say in anyone's league and shows no hidden picks: a site admin who isn't in a league can't see anything of it.

## Each league's own

| What | Where |
|---|---|
| Name, invite code, whether joiners get an entry | `leagues` |
| Members and commissioners | `league_members` (role `commissioner` or `member`) |
| Which week is open, and its rule set | `league_weeks` (one open week per league) |
| Rule-set versions | `rule_sets.league_id`; rule set 1 is the template every new league copies |
| Entries, banks, the weekly minimum, bets, standings | `entries.league_id`, `slips.league_id` (everything else hangs off the entry) |
| The admin log | `audit_log.league_id`; site-wide rows (a corrected score) have none and show in every league |

Row Level Security limits every league's rows to its members. Bets keep the single-league rules on top of that: hidden until kickoff, admins and commissioners included, and never visible outside the league even once revealed. Display names are visible only to people who share a league.

Commissioners have the single-league site's admin powers, for their own league: rules, entries and managers, bank adjustments, imports, opening and closing weeks, voiding bets, and the fair-play flag. The same guards apply (a commissioner can't join an entry that has other managers or bets riding; a league always keeps a commissioner).

## Starting and joining

- Anyone signed in can start a league (up to 10 each). It starts on the day-one rules, from week 1, with no week open.
- The commissioner shares the invite link (`#/join/CODE`). Joining adds the member, and, if the league allows it, an entry of their own at the rules' starting bank (`bank.startUnits`). A new link stops the old one.
- Commissioners can also add people by email (`add-member`), which makes an account if needed.

## Functions

League-level database functions take the league (`p_league`). Where it's the last argument it can be left out when the caller is in (or commissions) exactly one league; with several, the call is refused as `league_required`. Functions that act on an entry or a bet find its league themselves. The scheduled job advances every league's week on its own (`advance_week_internal`).

## From a single-league database

The migration `20261003000001_leagues.sql` works on a fresh database (no leagues) and on one that already holds the single-league site's data, which becomes its first league with nothing lost: its admins become its commissioners (and stay site admins), and everyone who manages an entry becomes a member.
