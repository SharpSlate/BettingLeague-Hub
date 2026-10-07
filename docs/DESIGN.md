# Design proposal

**Status:** draft for the owner's approval, 2026-09-28. Settled choices live in `../DECISIONS.md`; this document turns them into a build plan. The page list (section 8) gets checked against the Splash inventory once the owner's screenshots arrive. Nothing here is built yet.

## 1. The pieces

| Piece | Job |
|---|---|
| **GitHub Pages** | Hosts the site from this private repo (GitHub Pro). A static TypeScript + React app built with Vite, mobile-first, using `#/` routes so Pages needs no server. |
| **Supabase** | Postgres holds every entry, bet, line and ledger row. Auth handles sign-in (email and password, or Google; a forgotten password gets an emailed 6-digit code). Row Level Security decides who can read what. Edge Functions (TypeScript) place bets and run jobs. Cron schedules the jobs. The secret store holds the Odds API key. |
| **The Odds API** | Lines (DraftKings, with a backup book at no extra cost) and scores. |
| **GitHub Actions** | Runs the tests on every push. Deploys the site to Pages and the database changes and functions to Supabase, using keys kept in GitHub Secrets. |

Members' browsers talk to Supabase directly for reading. Every write that touches a bank goes through a server function; the browser can't write a table directly.

## 2. Placing a bet (the critical path)

1. **Build the slip.** The member taps lines on the Board. The browser checks the slip against the week's rule set and shows the exact payout. The check uses the same shared rules code the server uses (section 3).
2. **Submit.** The browser calls the `place-slip` Edge Function, which:
   - confirms the member manages the entry;
   - re-checks the slip against the rule set, with the same code;
   - pulls fresh lines first if the stored ones are more than 2 minutes old (3 credits, every game at once);
   - compares each leg with the current line and price. If any moved, it sends back the new numbers and the member must accept them before trying again.
3. **Record it atomically.** The function hands off to a database function, `place_slip`, which nobody but the server can call. In one transaction it:
   - locks the entry's row, so two slips submitted at once can't both spend the same units;
   - checks that the week is open;
   - checks that each leg's game hasn't kicked off, using the database clock (never the browser's);
   - checks that the stake is within the rule limits and the entry's available units, and that the lines are still current;
   - checks that the entry has no pending bet on the other side of any of the slip's games (the other team, by spread or moneyline, or the other side of the total), unless the rules allow it. Only bets the member can see count, so a manager added mid-week isn't told about hidden ones. The Edge Function asks the same question before it spends a line pull;
   - writes the slip, its legs and a ledger debit for the stake, stamped with the rule-set version and the person who placed it.

A member can undo a bet within 5 minutes of placing it, as long as none of its games has kicked off and none of its lines has moved since; the stake comes back. After that, bets are final. Undo goes through the same Edge Function (`{action: "undo", slipIds}`, up to 100 bets at once). It runs every other check first, so a bet that can't be undone costs no pull; each check returns the database's time. Then it pulls fresh lines, one pull for the whole request, and calls `undo_slip_internal` for real with that time. The database refuses the undo unless the lines on the board came from a pull whose request went out after that time (`line_pulls.fetched_after`, read from the database's clock just before the request), and only then compares each leg with the current line. So an undo is never checked against book lines from before it was asked for, however fresh they were (a commissioner-set line is compared as it stands). If the board's lines already came from a pull made after the ask (another undo's, a moment earlier), no new pull is needed. Undo pulls have limits of their own, apart from the bets': 10 a day per member and 100 a day in all (`undo_refresh_member_daily_cap`, `undo_refresh_daily_cap`), and at most one per member every 10 seconds; an undo arriving within those 10 seconds waits for that pull. So undoing can't use up the refreshes a member's bets rely on, and a burst of undo requests costs one or two pulls. If the lines can't be had (the feed is down, a limit is used up, the credit floor), the bet stays and the member is told why. Members can't call `undo_slip_internal` themselves. A line that's come off the board counts as moved; a teaser's legs, and flat-priced spreads and totals, are compared by their number only.

## 3. Rules engine

### One document per version

The league's rules are a single JSON document. Every change creates a new version and nothing is edited in place. The commissioner (or the owner, as the other admin) edits it on the Admin page.

| Area | Setting | Day-one value |
|---|---|---|
| Bet types | enabled types | straight, parlay, teaser |
| Straight | markets | spread, total, moneyline |
| Pricing | straight-bet prices | DraftKings' posted price |
| Parlay | legs | 2–10, any mix of spread / total / moneyline |
| Parlay | price | the legs' decimal odds multiplied together |
| Parlay | same game | no two legs from the same game (their results are related, so multiplying their odds overpays). The commissioner can allow each pairing |
| Teaser | legs | 2–10, any mix of spreads and totals; moneylines can't be teased |
| Teaser | points | 6, 6.5, 7 |
| Teaser | same game | no two legs from the same game, as for parlays |
| Teaser | price table | by (legs, points): Splash's 2- and 3-leg rows, plus the day-one rows below |
| Push rules | straight | stake back |
| Push rules | parlay | the leg drops out and the odds are recomputed; all legs pushed refunds |
| Push rules | teaser | **reduce**: the table price for the legs left (at least the 2-leg price); all pushed refunds |
| Stakes | minimum / maximum | 1 unit / 250,000 units (Splash's max), and never more than the entry's available units |
| Undo | window | 5 minutes after placing, only before any of the bet's games kicks off, and only while none of its lines has moved (a setting) |
| Across bets | both sides of a game | blocked: an entry can't bet both teams (by spread or moneyline, in any mix) or both the over and the under, in separate bets |
| Weekly minimum | percent, rounding | 30%, rounded up |
| Weekly minimum | penalty | the shortfall is deducted when the week closes |
| Visibility | others' picks | at each game's kickoff, leg by leg |
| Lock | when a leg locks | its own game's kickoff |
| Betting window | when a week opens | when the previous week's last game is final, or when an admin opens it |
| Bank | start / bonus | 10,000 / 5,000 (only matters for entries added later) |

### Versioning

- A new version names the week it takes effect. It must be a week that hasn't opened yet, so the rules never change mid-week. The database refuses anything else.
- Every slip stores the version it was placed under, and grading always uses that version. A rule change never regrades old bets.
- Each version records who made it, when, and a note. The Rules page shows the current rules in plain English plus the version history.

### Same code in both places

The rules code is one TypeScript module with no dependencies. It covers validating a slip, pricing it, and grading it from final scores. The site and the Edge Functions import the same file. The database separately enforces the things that must hold even if that code had a bug: kickoff locks, the open week, available units, and single-use of each stake.

### Teaser prices for 4–10 legs (day-one default; the commissioner can change them)

Splash only prices 2 and 3 legs. For longer cards, each leg past 3 needs 0.35 percentage points more to break even than a leg on Splash's 3-leg card, and each price is rounded down to a tidy number:

| Legs | 6 pts | 6.5 pts | 7 pts | Each 6-point leg must win |
|---|---|---|---|---|
| 2 (Splash) | −110 | −120 | −130 | 72.4% |
| 3 (Splash) | +180 | +160 | +140 | 70.9% |
| 4 | +285 | +250 | +215 | 71.4% |
| 5 | +425 | +365 | +310 | 71.8% |
| 6 | +615 | +520 | +425 | 72.0% |
| 7 | +860 | +710 | +575 | 72.4% |
| 8 | +1150 | +955 | +755 | 72.9% |
| 9 | +1550 | +1250 | +975 | 73.2% |
| 10 | +2100 | +1600 | +1200 | 73.4% |

The first version of these rows held the 3-leg break-even flat for every length (4 legs +290 up to 10 legs +2950 at 6 points). A flat break-even multiplies any per-leg edge: a player whose 6-point legs win 75% of the time expected about +18% on a 3-leg card but about +72% on a 10-leg card. With the rising break-even, that player expects about +18% on 3 legs and +22% to +28% on 4 to 10 legs, so a long card is no longer the place to press an edge. A player whose legs win 72% of the time comes out about even at 6 legs and behind on longer cards, like any long parlay. The owner asked for the change on Sept 28, for the commissioner to review; the commissioner can replace these rows for any future week.

## 4. Data model

All times are stored in UTC and shown in Eastern. Units are stored to the cent.

| Table | What it holds |
|---|---|
| `profiles` | One row per login: display name, admin flag. Email addresses stay in Supabase Auth and are never shown to other members. |
| `entries` | Display name, status, starting bank and bonus. |
| `entry_managers` | Which logins manage which entries (many to many). |
| `weeks` | Season, week number, label (Week 5, Wild Card…), window, status (upcoming / open / closed), who opened it and when, rule-set version in force. |
| `games` | Odds API event id, week, kickoff, teams, status (scheduled / live / final / postponed / void), scores. An admin can move a game to another week. |
| `teams` | Abbreviation, full name, name as the Odds API spells it. |
| `lines` | Game, market, side, point, price, book, source (Odds API or admin override), when fetched. A row is added only when the number changes, so the history is small and complete. |
| `rule_sets` | Version, effective week, the rules document, note, who, when. |
| `slips` | Entry, placed by, week, type, teaser points, stake, quoted price, potential payout, rule-set version, status (pending / won / lost / push / void), payout, placed and graded times. |
| `slip_legs` | Slip, game, market, side, quoted point and price, teased point, the line row it was priced from, result. |
| `ledger` | Every change to a bank, signed, with a reason: import, stake, payout, refund, weekly-minimum deduction, admin adjustment. **Available units = the sum of the ledger; bank = available + pending stakes.** |
| `week_entry_status` | Per entry per week: bank at the start, required minimum, amount wagered, shortfall deducted. |
| `entry_baselines` | Record, net, risk and return carried over from Splash at cutover, added to the standings. |
| `audit_log` | Every admin action and rule change, with before/after values and a reason. |
| `api_usage` | Each Odds API call: time, cost, credits remaining. |

## 5. Who can see and do what

- **Signed out:** the login page only.
- **Members** can read:
  - the standings, rules and schedule;
  - every game and line;
  - the audit log;
  - their own entries' bets, always (a co-manager added later sees the bets placed before they joined only as those games kick off, like everyone else);
  - other entries' bets only as each leg's game kicks off. Before that, the league sees only that a pick was placed, as on Splash;
  - another entry's parlay odds and payout only once every leg has kicked off, since the combined odds would give away the hidden legs.
- **Nobody writes tables directly.** Bets go through `place-slip`, and admin actions go through admin-only server functions that each write an audit row.
- **Admins** (the commissioner and the owner) can:
  - edit the rules (as a new version);
  - override or lock a line;
  - void or regrade a game or bet;
  - adjust a bank, with a reason;
  - add entries and managers;
  - open the next week;
  - import the Splash standings.

  Admin powers do **not** include seeing anyone's picks before kickoff. The database rules apply to admins the same way, and the admin tools are built so they can't be used to peek:
  - making yourself an entry's manager doesn't show you the bets it already placed, and the log names who was added to which entry; an admin can't add themselves to an entry that has other managers or bets riding, and an entry's last manager can't be removed while it has bets riding;
  - a kickoff can't be set in the past, moved once it has passed, or moved earlier once its week is open (real schedule changes come from the feed; to stop betting on a game at once, an admin marks it postponed), and a game that has started can't reopen for betting;
  - the admin log never shows a hidden bet's stake, or an entry's available units (which would show how much is riding on hidden bets);
  - only games in a week that hasn't opened can be moved to another week, so a refusal never tells an admin where bets are.
- **Hosting caveat:** whoever owns the Supabase project can read the database directly, as with any self-hosted site. The site itself never reveals picks early, and every change to a bank is in the ledger and the audit log.

## 6. Money math

- **Odds:** American to decimal is `1 + odds/100` for positive odds and `1 + 100/|odds|` for negative. Payout = stake × decimal odds. The math runs on exact fractions and rounds to the cent once, at the end.
- **Straight:**
  - win pays stake × decimal;
  - push or void returns the stake;
  - loss pays nothing.
- **Parlay:**
  - any losing leg loses the ticket;
  - pushed or void legs drop out and the rest are multiplied;
  - all legs pushed or void refunds the stake.
- **Teaser:**
  - each leg moves by the teaser points in the bettor's favor, then is graded like a spread or total;
  - any loss loses the card;
  - pushes follow the version's push rule. Under "reduce", a card cut down by pushes or voids pays the table price for the legs left, never less than the 2-leg price, so the table must have every row from 2 legs up, each paying more than the one before.
- **Leg grading:**
  - spread: team score + point against the opponent's score;
  - total: combined score against the point;
  - moneyline: the winner;
  - an exact tie on the number is a push.
- **Weekly minimum:**
  - when a week opens, each entry's bank is recorded and `required = ceil(0.30 × bank)`;
  - when the week closes, `shortfall = max(0, required − wagered)` comes off the bank as its own ledger row;
  - pushed bets count as wagered, and so do bets graded void because their game was cancelled; bets undone by the member or voided by an admin don't;
  - the deduction can never push a bank below zero;
  - the rest of the entry's bank carries into the next week;
  - if an admin voids a bet in a week that has already closed (the one change after a close that affects what counts), the week's minimum is worked out again and the difference goes on the ledger as its own row. What's owed is the new shortfall less the part waived at the close for lack of units, which stays waived. More owed is taken only from units free now; any part that can't be is recorded as unpaid and waived too. (The database also handles a shortfall that comes back down, cancelling the unpaid part first, so the result depends only on which bets count, not on the order of changes.)
- **Stopped games:** a game stopped after kickoff (an admin marks a game the feed shows under way as postponed) is voided instead, so its legs grade void and its later scores are ignored, even if it's finished another day. A game postponed before it starts keeps its bets riding until it's played or voided.
- **Corrections:** an admin can correct a final score, or void a final game. Either reopens the bets already graded on that game: each payout is taken back with its own ledger row, and the grading job grades the bet again within 10 minutes. Bets an admin voided stay void. A grade the job worked out just before a correction is refused when it arrives (it carries the version of each game it used), so it can't slip in with the old score.
- **Standings:** ranked by bank; ties broken by net, then total winnings. Net, Record, Risk and Return follow Splash's definitions, to be confirmed from the inventory. "This week" and "Last week" count bets by the week they belong to, so a Monday-night bet graded after midnight still counts in its own week.

## 7. Jobs

| Job | When | What |
|---|---|---|
| Pull lines | Checked every 10 minutes, 8:00am–1:00am ET: pulls every 30 minutes, or every 10 in the 3 hours before any game locks, plus when a bet or an undo needs it | One Odds API call for all games (3 credits); stores only changed numbers. A pull is due when waiting for the next check would leave the lines more than about the interval old (a minute's leeway keeps the regular pull on the same check each time). Only a good pull counts, a bet's included, so after a failed one the next check tries again; the same failure repeated shows once on the Admin page, with a count. An answer with no games while games are still to come counts as failed, and the board is kept, rather than taking every line down. A slip is checked before it can trigger a refresh, and bet refreshes are limited (one at a time, one per member per 5 minutes and 20 a day, 200 a day in all), so bets can't run the credits down. Every undo pulls, within the same daily limits |
| Pull scores | Every 10 minutes, but it calls the API only while a game is live or waiting on a final | Updates scores and statuses (2 credits). A game goes final when two pulls in a row report the same final score, so one bad reading isn't paid out. A game the feed has scores for closes to betting at once |
| Grade | After each score pull | Settles every slip whose legs are all final, and writes the payout to the ledger. A bet that can't be settled is reported and retried; it doesn't hold up the others or the week |
| Close / open week | When every game of the open week is final and graded, or when an admin opens the next week | Applies weekly-minimum deductions, records banks and minimums for the new week, opens its games |
| Props import | After each run of the owner's own prop pulls (twice a day, six times on Sundays) | The owner's PC sends the main lines of the five prop markets to `import-props`, which checks its key and stores them for games still open. No Odds API credits. A prop missing from the latest import is off the board, and so is one at a price no book posts for a main line. Props can't be bet once the latest import is 2 hours old, or, from 90 minutes before a kickoff, on an import pulled before then |
| Box scores | With the score job, once a game with props riding is final; or sent from the owner's PC (`import-boxes`) | Reads the game's box score from ESPN (free) and stores each player's yards, receptions and the touchdowns he scored. ESPN has refused the site's own requests, so the owner's PC can send ESPN's game summaries instead. Props are graded from it; a player not in it waits for an admin, unless his props came off the board once inactives were announced (then void) |
| Credit guard | Every Odds API call | Stops pulling if the plan's remaining credits drop below 5,000, and flags it to the admins |

Weeks run Tuesday to Monday, Eastern. A game belongs to the week its kickoff falls in unless an admin moves it; week 1 of 2026 started Tuesday, Sept 8. Playoff rounds are labeled by name, and the empty Pro Bowl week is skipped.

The feed can move a game's kickoff only while the game hasn't started; a game with bets keeps its week. A new start time takes two pulls in a row to stick (a game due within the hour follows one reading of an earlier time), and a start already in the past is never taken for a game more than an hour away, since it would show the game's picks early. Betting doesn't wait for the kickoff to move: it closes at the kickoff or at the feed's own start time, whichever comes first. Once a start time the feed reported ahead of time (or read twice in a row) has passed, betting on that game stays closed; a start first reported after it had passed closes betting only until a later reading disagrees. Score pulls run from either time. Scores are ignored for a game that both the league and the feed have more than an hour from its start; a game's first believable score starts it here too, which shows its picks. A game postponed after its kickoff keeps that kickoff: its bets ride, no new bets are taken, and it's graded when its final comes in, from the feed (which keeps checking for 3 days from the feed's new start time) or entered by an admin. An admin can close a week early only into a next week whose games are on the board; the season's last week is closed with its own "Close the season" step. The Admin page lists failed pulls, bets the grader couldn't settle, games that should have started an hour ago with no score, games stuck live or postponed with no final, and two entries that share a manager and took opposite sides of a game in the last week (once both picks are public).

## 8. Pages (draft; to be checked against the Splash inventory)

Phones get a bottom tab bar with five tabs; desktop gets a sidebar.

| Page | Contents | Covers Splash's |
|---|---|---|
| **Standings** (opens here) | Rank, entry, bank, net, record, total risked (graded bets plus bets still riding), return, and this week's minimum (met, or X of Y). Filters: season, this week, last week, last 7 days, custom. Tap an entry for its bets. | Standings, Home |
| **Board** | The open week's games (spread, total, moneyline with prices, kickoff in ET, line source and when it was updated). Started games are locked. The slip drawer has: which entry, straight / parlay / teaser and points, stakes, live payout, rule problems shown inline, and accepting a moved line. | Picks |
| **League Picks** | Everyone's revealed bets, by game or by entry, pending and settled, each with line, price, stake and result. Unrevealed picks show as "hidden until kickoff". Includes a latest-activity view. | Activity, Home's feed |
| **My Bets** | Each of your entries: bank, available, at risk, and weekly-minimum progress with a warning while short. Pending and Settled tabs. | Home's balance, My Entries, Pending, History |
| **League** | Rules in plain English with version history, the teaser table, the push rules, settings, schedule, entrants, the audit log, and payout info (paid offline). Admins also see the Admin section. | Contest details |

**Admin section:** rules editor (new version effective from a chosen week), lines (override or lock, pull status and credits left), games (void, postpone, move to a week), weeks (open the next one), entries and managers, bank adjustments, Splash import, void or regrade a bet.

**Also:** sign-in (code or Google) and a profile page (display name).

## 9. Cutover from Splash

1. Go-live is Tuesday, Oct 6 (week 5). Week 4 is a trial: the owner and the commissioner copy their Splash bets into the new site, and we compare the grading after Monday night, Oct 5.
2. The commissioner (or owner) supplies Splash's standings then.
3. Each entry's bank comes in as an `import` ledger row. Its record, net, risk and return become its baseline.
4. The trial entries (the owner's and the commissioner's) are imported once, after week 3, and then carry their own week 4 bets. At go-live they aren't imported again (an entry with bets can't be); if a trial entry's bank differs from Splash's after week 4, an admin adjusts it with a reason.
5. Pick history stays on Splash as a static snapshot and isn't migrated.

## 10. Testing and review

- **Rules code:** hand-checked test cases for every grading path. That covers straight, parlay and teaser, each with pushes, ties and voids, under all three teaser push rules and across more than one rule-set version. It also covers exact-cent rounding.
- **Database:** tests run on a local Postgres. They check that kickoff locks can't be beaten, that two simultaneous slips can't overspend, that hidden picks stay hidden (for admins too), and that the rules can't change mid-week. They also cover the weekly-minimum close and imports.
- **Jobs:** tested against saved Odds API responses.
- **Before anything goes live:** a separate adversarial review pass, as the handoff asks. The first pass (Sept 28) found about 30 distinct problems across the database, the betting math and the site; each confirmed one is fixed, with a test that reproduces it (`supabase/tests/review.test.ts` and the unit tests).

## 11. Owner setup (later, when we deploy)

- **Supabase project.** Keys go into GitHub Secrets: access token, project ref, database password.
- **Odds API key** → Supabase's secret store.
- **League email** for password-reset codes (a Yahoo or Gmail mailbox with an app password) → Supabase's email settings.
- **Google sign-in client** → Supabase's Google provider.
- **GitHub Pages source:** GitHub Actions.

## 12. Still open

1. **Standings definitions** for Net, Risk and Return, from the Splash inventory.
2. **Branding:** the name is BALTIMORE DEGENERATES; colors, logo and web address are still open.
3. **The commissioner's own complaints** about Splash.
4. **The review-fix defaults** listed under "Awaiting the owner" in `DECISIONS.md`.

## 13. Known limits

- **An early close shows totals.** If an admin closes a week while some of its bets are still hidden (a postponed game), the weekly-minimum ledger note shows each entry's total wagered that week, including those bets' stakes (not their picks). The week's totals table itself is readable only through the standings.
- **Co-managers see totals.** A manager added mid-week sees the entry's available units and at-risk total, which include bets placed before they joined, though not those bets' picks. For the same reason, the both-sides rule counts only bets a manager can see: one added mid-week can bet the other side of the entry's earlier hidden bets, since refusing them would show which side those bets are on.
- **Sign-in says who's a member.** Asking for a code for an email that isn't on the list says so. Supabase can add a CAPTCHA to the sign-in form if abuse ever becomes a problem.
- **Credits under abuse, and old lines.** Bets can trigger line refreshes, but at most one every 2 minutes overall, one every 5 minutes and 20 a day per member, and 200 a day in all (about 600 credits, whatever anyone sends); undos have their own limits (10 pulls a day per member, 100 in all, about 300 credits more at most). Past those limits, bets use the scheduled pulls' lines. While the pulls work, those are at most about 12 minutes old in the 3 hours before a kickoff and about 30 minutes old otherwise; each failed pull adds up to 10 minutes, and when a game enters its last 3 hours the schedule catches up at the next check. A member who has used up their 20 refreshes for the day could bet a line that old right after news breaks, if no one else's bet has refreshed it. Even within the limits, a member's bet can be on lines up to about 5 minutes old: a bet refreshes lines older than 2 minutes, but each member's bets at most once every 5 minutes. The credit floor stops pulls before the plan runs out.
- **Undo sees a move only once the feed shows it.** Every undo is checked against lines pulled after it was asked for, but a sportsbook takes time to move its line after news, and The Odds API takes time to pick the move up. An undo asked for in that gap goes through. A shorter undo window narrows it, and `undoMinutes: 0` closes it. Undo also compares only the line now with the bet's: a line that moved and moved back, or came off the board and returned unchanged, doesn't stop it.
- **Lines from a slow pull.** Pulls are stored one after another. If a pull that went out earlier is stored after a later one, the board shows the earlier pull's lines until the next pull. An undo in that moment is refused for a retry (the board's lines went out before it was asked for); a bet is placed on lines a few seconds older.
- **Entries that share a manager can bet against each other.** The site can't block it without telling one entry about another's hidden pick, so it flags it for the admins once both picks are public; the Rules page says such entries shouldn't. What happens then is a league matter. The flag counts a manager who managed both entries when the bets were placed, and anyone who placed both bets; a manager removed since who didn't place both isn't counted (manager changes are all in the admin log). When the same member placed both bets, blocking would reveal nothing; that isn't built.
- **Admins are trusted with managers.** An admin can't add themselves to an entry that has other managers or bets riding, and an entry's last manager can't be removed while it has bets riding. But an admin could still join an entry in steps on a quiet day (remove its manager, add themselves, put the manager back), or add a second account of their own as a manager, and see that entry's bets placed afterwards. Every manager change is in the admin log, with the member's and the entry's names, for everyone to see.
- **A wrong start time from the feed.** Betting on a game closes when the feed's start time passes, even if that time is wrong. A time first reported after it had already passed closes betting only until a later reading disagrees; one reported ahead of time (or read twice in a row) keeps betting closed, since a game that has started must never reopen. Its picks stay hidden until its kickoff here, and the admin page flags a game that should have started an hour ago with no score. To reopen such a game, an admin marks it postponed, pulls lines, and sets it back to scheduled: betting reopens only if the feed then shows a start still ahead, and every step is in the admin log. If the feed says a game is more than an hour away when it's really under way, betting stays open until its kickoff here or until an admin marks it postponed.
- **Props are as fresh as the owner's last pull.** They update only when the owner's PC runs its prop task. A prop can be bet only within 2 hours of a pull, and from 90 minutes before kickoff only on a pull made after the inactives came out, so props are open as much of the day as the pulls make them. A prop the books pull for injury news stays on the board until the next pull; the 2-hour limit and the small stake cap (2% of the maximum by default) are the guards.
- **Prop players are matched by name.** The books' name for a player is matched to the box score by name, ignoring suffixes and punctuation. A player who can't be found, or is only matched by first initial and last name, waits for a site admin, who answers with one click (didn't play, played with no stats, or the matched player's stats). Players ruled out before kickoff (their props came off the board after inactives) are voided without asking.
- **The project owner can read everything.** Whoever owns the Supabase project can read the database directly (see section 5).
