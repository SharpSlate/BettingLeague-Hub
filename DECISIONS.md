# Decisions

Settled choices for the league site, newest first. Anything not listed here is still open; see `HANDOFF.md` section 5.

| Date | Decision | By | Notes |
|---|---|---|---|
| 2026-09-28 | **No betting ahead:** a week's games open for betting only once the previous week's last game is final, normally the Monday night game. The commissioner can also open the next week by hand, e.g. when a game is postponed. | Owner | Splash lets people bet a week or two ahead. |
| 2026-09-28 | **Line pulls:** every 30 minutes from 8:00am to 1:00am daily (Eastern assumed), plus a fresh pull whenever a bet is submitted and the stored lines are more than 2 minutes old. If the fresh number differs from the slip's, the member must accept it before the bet goes in. Uses the owner's existing The Odds API plan (100K credits for $59/month). | Owner | Estimated 5,000–7,000 credits a month in total (3 credits per pull; scores included). The key is shared with another project; it goes in Supabase's secret store, never the repo. A safety stop halts pulls if the plan's remaining credits fall below a floor (default 5,000). |
| 2026-09-28 | **Build order:** first take an inventory of every Splash page, then write a parity checklist and build a clickable mockup of the new menus, then build. | Owner | The cloud session can't reach Splash, so the inventory comes from the owner's screenshots or pastes. |
| 2026-09-28 | **Line source:** The Odds API. | Owner | Handoff section 5, option (c). The refresh schedule and plan are still open. |
| 2026-09-28 | **Teasers:** up to 10 legs, any mix of spreads and totals, with no limits on blending them. | Owner | Still open: prices for 4–10 legs, the points options and the push rule. |
| 2026-09-28 | **Parlays:** up to 10 legs, any mix of spreads, totals and moneylines. | Owner | Replaces Splash's 2–8 legs. Same-game combinations are still open. |
| 2026-09-28 | **League picks page:** a separate page showing every entry's picks, pending and settled. | Owner | Still open: when other players' picks become visible (Splash reveals them at kickoff). |
| 2026-09-28 | **Landing page:** league Standings, replacing Splash's Home dashboard. | Owner | |
| 2026-09-28 | **Scope:** everything Splash does, with the menus reorganized so things are easier to find. | Owner | |
| 2026-09-28 | **Hosting:** the site is served by GitHub Pages from this private repo, on the owner's GitHub Pro plan ($4/month). | Owner | GitHub Free only publishes Pages from public repos. The site's address is still public, as for any website; everything past the login page needs an account. Pro also raises the Actions allowance to 3,000 minutes a month. |
