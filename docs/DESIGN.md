# Design proposal

**Status:** draft for the owner's approval, 2026-09-28. Settled choices live in `../DECISIONS.md`; this document turns them into a build plan. The page list (section 8) gets checked against the Splash inventory once the owner's screenshots arrive. Nothing here is built yet.

## 1. The pieces

| Piece | Job |
|---|---|
| **GitHub Pages** | Hosts the site from this private repo (GitHub Pro). A static TypeScript + React app built with Vite, mobile-first, using `#/` routes so Pages needs no server. |
| **Supabase** | Postgres holds every entry, bet, line and ledger row. Auth handles sign-in (emailed 6-digit code, or Google). Row Level Security decides who can read what. Edge Functions (TypeScript) place bets and run jobs. Cron schedules the jobs. The secret store holds the Odds API key. |
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
   - writes the slip, its legs and a ledger debit for the stake, stamped with the rule-set version and the person who placed it.

Bets are final once placed. The one proposed exception is a short undo window for typos (section 12).

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
| Parlay | same game | allowed: spread + total, moneyline + total. Blocked: spread + either moneyline, and both sides of one market |
| Teaser | legs | 2–10, any mix of spreads and totals; moneylines can't be teased |
| Teaser | points | 6, 6.5, 7 |
| Teaser | same game | everything allowed |
| Teaser | price table | by (legs, points): Splash's 2- and 3-leg rows, plus the proposed rows below |
| Push rules | straight | stake back |
| Push rules | parlay | the leg drops out and the odds are recomputed; all legs pushed refunds |
| Push rules | teaser | **reduce**: the table price for the legs left (at least the 2-leg price); all pushed refunds |
| Stakes | minimum / maximum | 1 unit / 250,000 units (Splash's max), and never more than the entry's available units |
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

### Proposed teaser prices for 4–10 legs (for the commissioner to set)

Splash only prices 2 and 3 legs. The rows below keep the per-leg break-even that Splash's own 3-leg price implies, rounded down to tidy numbers:

| Legs | 6 pts | 6.5 pts | 7 pts |
|---|---|---|---|
| 2 (Splash) | −110 | −120 | −130 |
| 3 (Splash) | +180 | +160 | +140 |
| 4 | +290 | +255 | +220 |
| 5 | +455 | +390 | +330 |
| 6 | +680 | +570 | +475 |
| 7 | +1000 | +820 | +670 |
| 8 | +1450 | +1150 | +930 |
| 9 | +2050 | +1650 | +1250 |
| 10 | +2950 | +2300 | +1750 |

The break-even rate per leg is 70.95% at 6 points, 72.72% at 6.5 and 74.69% at 7. Long cards multiply any per-leg edge: a player whose 6-point legs win 75% of the time expects about +18% on a 3-leg card at these prices, but about +72% on a 10-leg card. The commissioner should set the final rows.

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
  - the audit log (proposed);
  - their own entries' bets, always;
  - other entries' bets only as each leg's game kicks off. Before that, the league sees only that a pick was placed, as on Splash.
- **Nobody writes tables directly.** Bets go through `place-slip`, and admin actions go through admin-only server functions that each write an audit row.
- **Admins** (the commissioner and the owner) can:
  - edit the rules (as a new version);
  - override or lock a line;
  - void or regrade a game or bet;
  - adjust a bank, with a reason;
  - add entries and managers;
  - open the next week;
  - import the Splash standings.

  Admin powers do **not** include seeing anyone's picks before kickoff. The database rules apply to admins the same way.
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
  - pushes follow the version's push rule.
- **Leg grading:**
  - spread: team score + point against the opponent's score;
  - total: combined score against the point;
  - moneyline: the winner;
  - an exact tie on the number is a push.
- **Weekly minimum:**
  - when a week opens, each entry's bank is recorded and `required = ceil(0.30 × bank)`;
  - when the week closes, `shortfall = max(0, required − wagered)` comes off the bank as its own ledger row;
  - the deduction can never push a bank below zero;
  - the rest of the entry's bank carries into the next week.
- **Standings:** ranked by bank; ties broken by net, then total winnings. Net, Record, Risk and Return follow Splash's definitions, to be confirmed from the inventory.

## 7. Jobs

| Job | When | What |
|---|---|---|
| Pull lines | Every 30 minutes, 8:00am–1:00am ET, plus when a bet needs it | One Odds API call for all games (3 credits); stores only changed numbers |
| Pull scores | Every 10 minutes, but it calls the API only while a game is live or waiting on a final | Updates scores and statuses (2 credits) |
| Grade | After each score pull | Settles every slip whose legs are all final, and writes the payout to the ledger |
| Close / open week | When every game of the open week is final and graded, or when an admin opens the next week | Applies weekly-minimum deductions, records banks and minimums for the new week, opens its games |
| Credit guard | Every Odds API call | Stops pulling if the plan's remaining credits drop below 5,000, and flags it to the admins |

Weeks run Tuesday to Monday, Eastern. A game belongs to the week its kickoff falls in unless an admin moves it; week 1 of 2026 started Tuesday, Sept 8. Playoff rounds are labeled by name, and the empty Pro Bowl week is skipped.

## 8. Pages (draft; to be checked against the Splash inventory)

Phones get a bottom tab bar with five tabs; desktop gets a sidebar.

| Page | Contents | Covers Splash's |
|---|---|---|
| **Standings** (opens here) | Rank, entry, bank, net, record, risk, return, and this week's minimum (met, or X of Y). Filters: season, this week, last week, last 7 days, custom. Tap an entry for its bets. | Standings, Home |
| **Board** | The open week's games (spread, total, moneyline with prices, kickoff in ET, line source and when it was updated). Started games are locked. The slip drawer has: which entry, straight / parlay / teaser and points, stakes, live payout, rule problems shown inline, and accepting a moved line. | Picks |
| **League Picks** | Everyone's revealed bets, by game or by entry, pending and settled, each with line, price, stake and result. Unrevealed picks show as "hidden until kickoff". Includes a latest-activity view. | Activity, Home's feed |
| **My Bets** | Each of your entries: bank, available, at risk, and weekly-minimum progress with a warning while short. Pending and Settled tabs. | Home's balance, My Entries, Pending, History |
| **League** | Rules in plain English with version history, the teaser table, the push rules, settings, schedule, entrants, the audit log, and payout info (paid offline). Admins also see the Admin section. | Contest details |

**Admin section:** rules editor (new version effective from a chosen week), lines (override or lock, pull status and credits left), games (void, postpone, move to a week), weeks (open the next one), entries and managers, bank adjustments, Splash import, void or regrade a bet.

**Also:** sign-in (code or Google) and a profile page (display name).

## 9. Cutover from Splash

1. Pick a Tuesday.
2. The commissioner (or owner) supplies Splash's standings then.
3. Each entry's bank comes in as an `import` ledger row. Its record, net, risk and return become its baseline.
4. Pick history stays on Splash as a static snapshot and isn't migrated.
5. Optional: run a trial week first. The owner and commissioner copy their Splash bets into the new site, and we compare the grading.

## 10. Testing and review

- **Rules code:** hand-checked test cases for every grading path. That covers straight, parlay and teaser, each with pushes, ties and voids, under all three teaser push rules and across more than one rule-set version. It also covers exact-cent rounding.
- **Database:** tests run on a local Postgres. They check that kickoff locks can't be beaten, that two simultaneous slips can't overspend, that hidden picks stay hidden (for admins too), and that the rules can't change mid-week. They also cover the weekly-minimum close and imports.
- **Jobs:** tested against saved Odds API responses.
- **Before anything goes live:** a separate adversarial review pass, as the handoff asks.

## 11. Owner setup (later, when we deploy)

- **Supabase project.** Keys go into GitHub Secrets: access token, project ref, database password.
- **Odds API key** → Supabase's secret store.
- **League email** for sign-in codes (e.g. a new Gmail with an app password) → Supabase's email settings.
- **Google sign-in client** → Supabase's Google provider.
- **GitHub Pages source:** GitHub Actions.

## 12. Still open

1. The teaser rows for 4–10 legs (section 3), and whether to keep 6 / 6.5 / 7 points.
2. **Undo window:** can a member undo a bet within 2 minutes of placing it, before kickoff, to fix typos? After that, bets are final.
3. **Weekly-minimum details:** do pushed bets count as wagered (proposed: yes), and do bets an admin voids count (proposed: no)?
4. **Audit log:** readable by all members (proposed: yes).
5. **Standings definitions** for Net, Risk and Return, from the Splash inventory.
6. Cutover week and whether to run a trial week.
7. Name, branding and domain.
8. The commissioner's own complaints about Splash.
