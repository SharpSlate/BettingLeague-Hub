# Handoff: a replacement site for the "BALTIMORE DEGENERATES 26-27" NFL betting league

Written 2026-09-27 by the local Claude Code session on the owner's PC, for a new **cloud session** that will build the site. Everything the local session knows about the league is below. The cloud session can't reach any of these sources itself: Splash, the owner's Chrome, his local app or its memory files.

## 0. Ground rules

- **Owner:** bappel2 on GitHub. He plays in the league with two entries.
- **Commissioner:** Splash handle `ARMYTERP23`. He runs the league and dislikes Splash.
- **Goal:** the owner offered to build a site with more functionality than Splash that is easier to use, built on GitHub. What exactly the commissioner hates about Splash has **not been recorded. Ask the owner first.**
- **★ The rules must be editable (owner, 2026-09-27).** A big reason for leaving Splash is its rigid rules, especially which teaser legs are allowed and what can be combined. The league wants to change those. **Splash's rules in section 1 are the starting defaults, not requirements.** Every limit, price table and combination rule should be commissioner-editable configuration (section 4, "Rules engine"), never hard-coded.
- **No access to Splash from the cloud.** Don't scrape Splash or store Splash logins. Anything needed from Splash, such as standings for the cutover, comes from the owner or the commissioner as a paste or screenshot.
- **Play units only.** Real money (a $100 buy-in; top 3 paid 55% / 35% / 10%) is collected and paid out offline by the commissioner. The site must never take payments or hold money.
- **No secrets in the repo.** Keys belong in GitHub Secrets or the backend's env vars.
- **Privacy.** Don't commit other members' names, handles or balances. The commissioner supplies the member list at cutover.
- **Keep the owner's private tools out.** The owner has private betting-analysis tools (the OneStopShop repo: pricing models and edge finders). They stay out of this project. The site needs settlement math, not edge models, and the owner is a player in this league, so the site must be neutral: published rules, a clear line source, and an audit log of every bank change.
- **Owner's working style:** build it, then have a separate adversarial review pass check it before anything goes live. Verify claims before stating them.

## 1. How the league works today (Splash "Shares" format)

### Splash's own Settings and Rules pages (read 2026-09-27)

**Settings**

| Setting | Value |
|---|---|
| Starting bank | 10,000 units |
| Max per pick | 250,000 units |
| Share price | 1 unit |
| Sport | NFL only |
| Pick types | Money Line, Spread, Total, Parlay, Teaser |
| Pick visibility | Hidden until game start |
| Parlay legs | 2–8 |
| Teaser points | 6, 6.5, 7 |

**Rules**

- A winning pick returns stake plus winnings. A losing pick forfeits its stake.
- A **push or voided pick returns the stake** and counts as neither a win nor a loss.
- You can stake up to your available bank.
- The leaderboard ranks entries by bank (start + winnings − losses). Ties break by net result, then by total winnings.
- The largest bank after the Super Bowl wins. **Playoff weeks count.**

### House rules (commissioner; Splash doesn't enforce them)

- **Minimum weekly wager: at least 30% of your bank, every week.** Week 1 was 30% of the pre-bonus 10,000, i.e. 3,000. Formula: `ceil(0.30 × bank)`.
- There was a **5,000-unit early sign-up bonus**, so most entries started at 15,000.
- 22 entries as of 9/27. Some people run two entries. The owner has **two separate Splash logins** (`HafKiwiHolApple` and `BenAndCorey`) because Splash has no multi-entry support.

### Pricing and combination rules the owner verified in Splash's bet slip (9/12–9/13, nothing submitted)

These are Splash's rules, and **exactly what the league wants the freedom to change.** Use them as the day-one default rule set only.

- **Straight bets:** spreads and totals at −110. Moneylines at posted prices.
- **Teasers:**
  - spreads only; a total is allowed only alongside a spread
  - moneylines can't be teased
  - **3 legs max**
  - both sides of one game are blocked
  - an all-totals 3-leg teaser was refused
  - prices:

    | Legs | 6 pts | 6.5 pts | 7 pts |
    |---|---|---|---|
    | 2 | −110 | −120 | −130 |
    | 3 | +180 | +160 | +140 |

- **Parlays:**
  - 2–8 legs at naively multiplied odds
  - same-game moneyline + total and spread + total are **allowed**
  - **blocked within one game:** over + under, both spreads, a spread + either moneyline. Splash's message: "These picks can't be combined in one parlay".
- **Teaser push rule: unpublished.** Splash states nothing, and no graded push has been seen yet. The owner believes a pushed leg is **voided** and the card is graded on the legs left, at the price for that many legs at the same points; a lone surviving leg gets the 2-leg price, so every reduced 6-pt card is −110. The new site should **state this rule explicitly**; that alone beats Splash.
- **Lines:** Splash posts one line per game and moves it only sometimes, so spreads go **stale** against the market. Examples: week 1 PIT −3 offered vs −6 in the market; week 3 CLE +2.5 vs DraftKings +1.5. Moneylines track the market better.

### Splash's pages (the feature baseline to beat)

| Page | What it shows |
|---|---|
| Home | Contest landing page |
| My Entries | The logged-in user's entries |
| Picks | The board: one card per game with spread, total, moneyline and prices, plus the bet slip |
| Pending | The logged-in entry's open picks |
| Standings | Rank, entry, Bank, Net, Record, Risk, Return; filters for Season / This week / Last week / Last 7 days / Custom |
| History | An entry's graded picks |
| Activity | League-wide feed of picks, visible after lock |
| Contest details | Tabs: Overview, Settings, Rules, Schedule, Entrants |

As text, a board card reads:
`Sun, Sep 27, 1:00 PM EDT | Seahawks at Commanders | SPREAD | TOTAL | MONEY LINE | SEA | -7.5 | -110 | O 40.5 | -110 | -375 | WAS | +7.5 | -110 | U 40.5 | -110 | +300`
A finished game shows only the score: `ATL | 35 | GB | 14`.

**Pain points Splash visibly has:**
- no multi-entry support (hence two logins)
- the 30% house rule isn't tracked
- no stated teaser push rule
- stale lines

The commissioner's own complaints are still to be collected from the owner.

## 2. How the local session connects to Splash (context only; none of it carries over)

- **Access is read-only,** through the Claude in Chrome extension driving the owner's already-logged-in Chrome (the BenAndCorey login). The local session never places or edits picks; the owner does that himself.
- **URL pattern:** `https://contests.app.splashsports.com/shares/contests/contest_01M1VQ3HTWECN9G23PF8FHHHKK/{pick|pending|standings|history|activity|entries|detail}`, with `detail/rules` and `detail/settings` as sub-tabs.
- **How the board is read:** each game on the Picks page is an `<article>`. Its innerText, joined with `" | "`, is the format above.
- **Splash's data API** (seen in network traffic, never used): `api.splashsports.com/contests-service-v2/api/contests/{contest}/slates/{slate}/games`, plus `/shares/balance`, `/my-entries`, `contests/slates`. It needs a bearer token from `api.auth.splashsports.com`, and a plain fetch from the page fails (CORS). **Don't build on it.**
- **Local code** (private OneStopShop repo; reference only):
  - `core/fantasy/nfl_shares.py`: board and standings parsing, DraftKings lines via ESPN, teaser and push math
  - `core/fantasy/nfl_shares_sim.py`: a season simulator
  - a "Shares" tab in the owner's local Streamlit app
  - `store/fantasy/shares.json` (gitignored): banks and saved boards
- **State on 9/27, before the week-3 Sunday games:** 22 entries. The owner's BenAndCorey is 4th (19,227.30) and HafKiwiHolApple is 15th (10,527.30).

## 3. Pieces worth porting (rewrite in the site's language; this is the logic)

### Games, scores and lines: ESPN's public scoreboard JSON (free, no key)

The local tool already relies on this endpoint:

```
https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=2026&seasontype=2&week=<1-18>
```

- **Playoffs:** `seasontype=3`, where week 1 = Wild Card, 2 = Divisional, 3 = Conference, 5 = Super Bowl (4 is the Pro Bowl; skip it).
- **Per event:** use `competitions[0]`.
  - status: `status.type.state` is `pre` / `in` / `post`
  - teams and scores: `competitors[]` (`homeAway`, `team.abbreviation`, `score`)
  - kickoff: `date` (UTC)
- **DraftKings odds:** the entry in `competitions[0].odds[]` with `provider.name == "DraftKings"`.
  - spread: `pointSpread.{home,away}.close.{line,odds}`
  - total: `total.{over,under}.close.{line,odds}`
  - moneyline: `moneyline.{home,away}.close.odds`
  - values arrive as strings: `"-7"`, `"+7"`, `"PK"`, `"o44.5"`, `"-108"`, `"EVEN"`
  - the two spread lines must sum to 0
- **Odds disappear at kickoff.** Snapshot the line and price onto each pick when it's placed, and grade from the snapshot.
- **Team codes:** normalise ESPN/Splash variants (JAC→JAX, WSH→WAS, LA→LAR if you key by team).
- **Injuries**, if wanted: `.../nfl/summary?event=<id>` has an `injuries` list per team.

### Settlement (grade from scores; test every case with hand-checked fixtures)

- **Spread:** team score + line vs the opponent's. Equal is a push (stake back).
- **Total:** combined score vs the line. Equal is a push.
- **Moneyline:** winner by score. A tie is a push.
- **Parlay:** any losing leg loses the ticket. A pushed or voided leg drops out and the odds are recomputed on the remaining legs. All legs pushed refunds the stake.
- **Teaser:** shift each leg by the teaser points, then grade as a spread. Any loss loses the card. All legs won pays the card price. Pushed legs follow the rule the commissioner picks.
  - Owner's belief ("reduce"): the card is regraded at the price for the remaining legs at the same points; one leg left gets the 2-leg price; all pushed is a refund.
  - The local code has this as `reduced_price` / `card_outcomes`: `reduced_price(left, legs, price)` returns the table price for `max(2, left)` legs at the card's points, or a refund if `left == 0`.
- **Money:** American odds to decimal is `1 + odds/100` for positive odds and `1 + 100/|odds|` for negative. Payout = stake × decimal.
- **Weekly minimum:** `ceil(0.30 × bank at the start of the week)`, with week 1 on the pre-bonus bank.

## 4. Recommended architecture ("built using GitHub")

- **Repo:** a new **private** GitHub repo, created by the owner, with the cloud session started on it.
- **Front end:** a static site on **GitHub Pages**. The owner already runs a Pages site (SharpSlate). Mobile-first; most picks are made on phones.
- **Backend:** Pages alone can't log people in or store picks, so pair it with **Supabase** (free tier: Postgres, Auth, Row Level Security; the owner has used Supabase before).
  - Magic-link email login.
  - **One user, many entries.**
  - Row Level Security so a member sees others' picks **only after their game's kickoff**.
  - **Pick locking enforced in the database** (insert/update rejected after the game's kickoff, checked server-side against the stored UTC kickoff). Never trust the browser clock.
- **Scheduled jobs:** **GitHub Actions** on cron do the following, with the Supabase service key in GitHub Secrets only:
  - pull lines and scores from ESPN (e.g. every 10 minutes on game days, hourly otherwise)
  - grade finished games
  - write ledger rows
  - recompute standings
  - flag entries under the weekly minimum
- **Rules engine (required).** The rules live in a versioned `rule_sets` table (or JSON document) that the commissioner edits in an admin screen. The bet slip validates against it, and the server re-validates every pick, with the same code in both places if possible.
  - **What it covers, at minimum:**
    - which pick types are enabled
    - min/max stake, and the max as a % of bank
    - parlay min/max legs
    - teaser point options and a **price table by (legs, points)**, for any number of legs the commissioner allows
    - **which markets may be teased** (spreads, totals, and whether totals need a spread alongside)
    - **the same-game combination matrix** for parlays and teasers (e.g. spread + total allowed; both sides blocked)
    - the push rule per bet type
    - the weekly minimum %
    - pick visibility
    - the lock rule (each game's kickoff vs. the first game of the week)
    - starting bank and bonus
  - **Versioning:**
    - a change takes effect from a chosen week (default: the next Tuesday), never mid-slate
    - every pick stores the id of the rule-set version it was placed and graded under, so a rule change never regrades old picks
    - every change lands in the audit log and shows on the site's Rules page with its effective week
  - **Grading reads its terms from the pick's rule version:** teaser price for the legs left after a push, push rule, and so on. It never reads current settings.
- **All-GitHub alternative:** Actions plus a data branch, with picks submitted through Issues or forms. It's clunky and has no real auth; not recommended. Decide with the owner.

## 5. Decisions to settle with the owner and commissioner before coding

1. **Line source:**
   - (a) the commissioner posts lines by hand, like Splash (stale risk)
   - (b) automatic DraftKings lines from ESPN's JSON with a commissioner override (fresh and free, but an unofficial public endpoint; fine for a private pool)
   - (c) The Odds API (licensed, costs credits; the owner's key belongs to another project, so ask him first)
2. **Pricing:** stale lines and Splash's 6-pt teaser prices are where sharp players find value, and a fresh-line site changes that. Keep Splash's prices or reprice? It's the commissioner's call, and whatever is chosen gets published.
3. **Teaser push rule:** pick one and show it on the slip.
4. **30% weekly minimum:** display only, warn, or enforce with a penalty?
5. **Mid-season cutover:** switch at a week boundary (Tuesday). Import each entry's bank, net, record and totals from Splash's standings, supplied by the commissioner or owner. Decide whether old pick history migrates; probably keep a static snapshot instead.
6. **Which rules change at launch?** The engine makes all of them editable, but the commissioner should give the day-one rule set. Candidates:
   - teaser legs beyond 3, and the price table that goes with them
   - teasing totals or mixing totals and spreads
   - the same-game combinations Splash blocks
   - max stake (250,000 now)
   - parlay leg limits (2–8 now)
   - hidden picks until kickoff
7. **Playoffs** count, including the one-game Super Bowl week.
8. **Name, domain, branding.**

## 6. Suggested MVP, in order

1. **Schema:**
   - `users`
   - `entries`: user, display name, starting bank, bonus
   - `games`: ESPN id, season, week, kickoff UTC, teams, state, scores
   - `lines`: game, market, side, line, price, source, fetched_at
   - `rule_sets`: version, effective week, the full rule document (JSON), changed_by, changed_at
   - `picks`: entry, type, stake, price, points, status, placed_at, graded_at, rule_set_version
   - `pick_legs`
   - `ledger`: every bank change, with a reason
   - `audit_log`
2. **Rules engine and commissioner rules editor** (section 4), seeded with Splash's rules as the defaults.
3. **Board and bet slip:** straight, parlay and teaser, with live payout, validated against the active rule set (on the server too).
4. **Locking and visibility at kickoff,** or whatever lock rule the rule set says.
5. **Grading job with unit tests** covering every push case (straight, parlay, teaser) and ties, under more than one rule-set version.
6. **Standings** (Bank / Net / Record / Risk / Return, with Splash's filters), plus My Picks (pending and history) and the league Activity feed after lock.
7. **Weekly-minimum tracker** per entry.
8. **Commissioner admin:**
   - set or override lines
   - void a game or pick
   - adjust a bank (with a reason, written to the ledger)
   - add entries
   - import the Splash standings snapshot
9. **Nice to have:** notifications before lock, CSV export, per-week recap.

**Store times in UTC and display them in ET;** every kickoff on the board is Eastern.

## 7. First message for the cloud session

Add this file to the new repo as `HANDOFF.md`, or paste it into the chat, then send:

> Read `HANDOFF.md`. Before writing code, ask me the section 5 questions and what the commissioner dislikes about Splash, then propose the schema, the rules-engine design and the page list for approval. The rules must be commissioner-editable, not Splash's fixed rules. Build on the section 4 stack unless I choose otherwise. Test grading with hand-checked fixtures, and run a separate review pass before anything goes live.
