# Decisions

Settled choices for the league site, newest first. Anything not listed here is still open; see `docs/DESIGN.md` section 12.

## Awaiting the owner

Defaults chosen while fixing the review findings (Sept 28–29). Each is built and tested; say the word to change any of them.

| Default | Why |
|---|---|
| A game goes final only when two score pulls in a row agree (grading waits about 10 minutes). | One bad reading from the feed isn't paid out. |
| Correcting a final score regrades that game's bets automatically: payouts are taken back and paid again, each as its own ledger row. Bets an admin voided stay void. | The design promised "void or regrade"; before, a wrong score couldn't be fixed. |
| A co-manager added mid-week sees the entry's hidden bets placed before they joined only at kickoff, like everyone else. | Otherwise an admin could add themselves to any entry and see its picks. |
| Other members see a parlay's odds and payout only after every leg kicks off. | The combined odds give away the hidden legs. |
| A bet can't be undone once its week has been closed, even inside the 5 minutes. | An early close could otherwise be used to dodge the 30% minimum. |
| The season's last week is closed by an admin with its own "Close the season" step; "Open next week" won't close a week until the next week's games are on the board. | The site can't tell "the season is over" from "next week's games aren't posted yet", and betting should never stall with no week open. |
| Once a week is open, an admin can move a kickoff later but not earlier; real schedule changes come from the feed, and "postponed" stops betting on a game at once. | Moving a kickoff earlier would show its picks early. |
| Entering a game's same final score again regrades its bets. | A way to fix a bet graded wrong without changing the score. |
| A new rules version can't start before one that's already scheduled. | Keeps "the newest version applies from its week on" unambiguous. |
| Standings' "This week" and "Last week" count bets by their week, not by when they were graded. | A Monday-night bet graded after midnight belongs to its week. |
| A game postponed after kickoff keeps its bets riding and takes no new bets; it's graded when its final comes in. | Reopening a game after kickoff would allow betting with hindsight. |
| New members must be given a display name; it's never taken from their email. | Display names are public. |

## Settled

| Date | Decision | By | Notes |
|---|---|---|---|
| 2026-09-28 | **Site name:** BALTIMORE DEGENERATES. | Owner | Colors, logo and web address are still open. |
| 2026-09-28 | **Cutover:** week 4 is a trial beside Splash. The owner and the commissioner copy their Splash bets into the new site, and the grading is compared after Monday night, Oct 5. Everyone switches on Tuesday, Oct 6, for week 5. | Owner | Splash stays official for week 4. The standings are imported from Splash after week 4. |
| 2026-09-28 | **Admin log:** every admin action and rule change is readable by all members. | Owner | |
| 2026-09-28 | **Weekly minimum, what counts:** pushed bets count as wagered; bets an admin voids don't, and neither do undone bets. | Owner | |
| 2026-09-28 | **Undo window:** a member can undo a bet within 5 minutes of placing it, as long as none of its games has kicked off. The stake comes back. After that, bets are final. | Owner | For typos. |
| 2026-09-28 | **Teaser points and prices:** keep 6, 6.5 and 7 points. The day-one price rows for 4–10 legs are the ones proposed in `docs/DESIGN.md` section 3. | Owner | The commissioner can change the rows for any future week. |
| 2026-09-28 | **Login:** members can sign in with a 6-digit code emailed to them, or with Google. | Owner | The owner sets up both later: a league email address to send the codes (e.g. a new Gmail with an app password) and a Google sign-in client. |
| 2026-09-28 | **Admins:** the commissioner and the owner. | Owner | Every admin action goes in a log all members can read (see the admin-log row). Admin powers never include seeing anyone's picks before kickoff. |
| 2026-09-28 | **Shared entries:** an entry can have several managers, and each can bet for it. Every bet records who placed it. | Owner | One login can also hold several entries. |
| 2026-09-28 | **30% weekly minimum:** when a week closes, any shortfall is deducted from the bank automatically. The shortfall is the required amount minus the amount wagered that week. | Owner | Required = ceil(0.30 × bank at the start of the week). Entries see their progress and a warning while they're short. What counts as wagered: see the row above. |
| 2026-09-28 | **Pick visibility:** other entries' picks become visible at each game's kickoff. Parlay and teaser legs are revealed game by game; before that the league sees only that a pick was made. | Owner | Same as Splash. |
| 2026-09-28 | **Teaser push rule:** reduce. A pushed leg drops out and the card pays the table price for the legs left; a lone surviving leg gets the 2-leg price. All legs pushed refunds the stake. | Owner | What the owner believes Splash does. It will be printed on the bet slip. |
| 2026-09-28 | **Straight-bet prices:** spreads, totals and moneylines pay DraftKings' posted prices. | Owner | Replaces Splash's flat −110 on spreads and totals. |
| 2026-09-28 | **Same-game parlays:** blocked: a spread with either moneyline on the same game, and both sides of any one market (over + under, both spreads, both moneylines). Allowed: spread + total and moneyline + total. | Owner | A spread with the same team's moneyline is one bet paid at two bets' odds. Both-sides combinations can't win. |
| 2026-09-28 | **No betting ahead:** a week's games open for betting only once the previous week's last game is final, normally the Monday night game. The commissioner can also open the next week by hand, e.g. when a game is postponed. | Owner | Splash lets people bet a week or two ahead. |
| 2026-09-28 | **Line pulls:** every 30 minutes from 8:00am to 1:00am daily (Eastern assumed), plus a fresh pull whenever a bet is submitted and the stored lines are more than 2 minutes old. If the fresh number differs from the slip's, the member must accept it before the bet goes in. Uses the owner's existing The Odds API plan (100K credits for $59/month). | Owner | Estimated 5,000–7,000 credits a month in total (3 credits per pull; scores included). The key is shared with another project; it goes in Supabase's secret store, never the repo. A safety stop halts pulls if the plan's remaining credits fall below a floor (default 5,000). |
| 2026-09-28 | **Build order:** first take an inventory of every Splash page, then write a parity checklist and build a clickable mockup of the new menus, then build. | Owner | The cloud session can't reach Splash, so the inventory comes from the owner's screenshots or pastes. |
| 2026-09-28 | **Line source:** The Odds API. | Owner | Handoff section 5, option (c). Schedule: see the line-pulls row. |
| 2026-09-28 | **Teasers:** up to 10 legs, any mix of spreads and totals, with no limits on blending them. | Owner | Points and prices: see the teaser points row. Push rule: see the teaser push row. |
| 2026-09-28 | **Parlays:** up to 10 legs, any mix of spreads, totals and moneylines. | Owner | Replaces Splash's 2–8 legs. Same-game rules: see the same-game parlays row. |
| 2026-09-28 | **League picks page:** a separate page showing every entry's picks, pending and settled. | Owner | When picks become visible: see the pick-visibility row. |
| 2026-09-28 | **Landing page:** league Standings, replacing Splash's Home dashboard. | Owner | |
| 2026-09-28 | **Scope:** everything Splash does, with the menus reorganized so things are easier to find. | Owner | |
| 2026-09-28 | **Hosting:** the site is served by GitHub Pages from this private repo, on the owner's GitHub Pro plan ($4/month). | Owner | GitHub Free only publishes Pages from public repos. The site's address is still public, as for any website; everything past the login page needs an account. Pro also raises the Actions allowance to 3,000 minutes a month. |
