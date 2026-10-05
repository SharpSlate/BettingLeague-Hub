# Setting up the site

This is the multi-league site. It runs on its **own** GitHub repository and its **own** Supabase project, never the single-league site's (the deploy refuses to run from `SharpSlate/BettingLeague`).

One-time steps for the owner, roughly in this order. Nothing secret ever goes in this repo or in chat: every key goes into **GitHub Secrets** (repo **Settings → Secrets and variables → Actions**), and the deploy workflow hands it to Supabase.

The menu names below are as of September 2026. If a screen looks different, the Claude session can walk you through it.

## 1. Supabase project

1. At [supabase.com](https://supabase.com), sign in and create a **new project**:
   - name: `betting-league`
   - region: East US
   - a strong database password, saved somewhere safe

   The free plan allows two active projects. If you already have two, pause one.
2. From the project's settings, note:
   - the **project ref**: the 20-letter id in the project URL;
   - the **project URL**: `https://<ref>.supabase.co`;
   - the **publishable (anon) key**, which is meant to be public.
3. In your Supabase account settings, create a **personal access token** for the deploy workflow.

## 2. Site email for password resets

Members sign in with an email and a password, so the site only sends email when someone forgets their password: a 6-digit code. Supabase's built-in email only reaches the project's own team, so everyone else's codes need a mailbox of the site's own, at Yahoo or Gmail.

- **Yahoo:** at [Account Security](https://login.yahoo.com/account/security), under **External connections**, choose **Create app password**. Yahoo keeps that button grayed out for the first days of a new account.
- **Gmail:** turn on 2-Step Verification, then create an **app password** under the account's Security settings.

The address and its app password go in the `SMTP_USER` and `SMTP_PASS` secrets (step 4); the deploy picks Yahoo's or Gmail's mail server from the address. The deploy works without them, but then only you get reset emails, with a link instead of a code: on Supabase's free plan, its own sender keeps its standard email (open the link in the browser you asked from). Signing in and making an account never need email.

## 3. Google sign-in (optional for the trial)

1. In [Google Cloud Console](https://console.cloud.google.com), create an **OAuth client ID** of type *Web application*.
2. Add this authorized redirect URI: `https://<ref>.supabase.co/auth/v1/callback`
3. Note the client ID and client secret.

Until this is set up, the site doesn't show the "Continue with Google" button; members sign in with their email and password. Add the two secrets any time and the button appears after the next deploy.

## 4. GitHub settings

In **Settings → Secrets and variables → Actions**:

**Variables** tab (these values aren't secret):

| Name | Value |
|---|---|
| `SUPABASE_PROJECT_REF` | the project ref |
| `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | the publishable (anon) key |
| `SITE_URL` | the new repo's Pages address, e.g. `https://sharpslate.github.io/BettingLeague-Hub/` |

**Secrets** tab:

| Name | Value |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | the personal access token from step 1 |
| `SUPABASE_DB_PASSWORD` | the database password from step 1 |
| `ODDS_API_KEY` | your The Odds API key (one pull serves every league; a key shared with another site shares its monthly credits) |
| `CRON_SECRET` | any long random string (it lets the scheduler call the functions) |
| `SMTP_USER` | the site's Yahoo or Gmail address |
| `SMTP_PASS` | its app password |
| `GOOGLE_CLIENT_ID` | from step 3 (optional) |
| `GOOGLE_CLIENT_SECRET` | from step 3 (optional) |

Then in **Settings → Pages**, set **Source** to **GitHub Actions**.

## 5. First deploy

Merge the working branch into `main`. The **Deploy** workflow then:
1. runs every test;
2. applies the database migrations;
3. applies the sign-in settings and function secrets;
4. deploys the functions;
5. publishes the site to the repo's Pages address.

You can watch it under the repo's **Actions** tab. After this, every merge to `main` redeploys.

## 6. Make yourself the site admin

Site admins run what every league shares: the line and score feeds, line overrides, game status and score corrections. Being one gives no say in anyone's league and shows no hidden picks.

1. Sign in on the site once with your email (sign-ups are open).
2. In the Supabase dashboard's **SQL editor**, run:
   ```sql
   select app.bootstrap_admin('your-email@example.com');
   ```
3. Reload the site: **Admin** now has **Site feeds** and **Games & lines**.

## 7. Turn on the odds feed

The site starts with its odds feed off: nothing calls The Odds API, so no credits are spent, and the board stays empty, so no league can open a week. Turn it on when the site is ready to launch. In the Supabase dashboard's **SQL editor**, run:
```sql
update public.league_settings set odds_pulls_enabled = true;
```
Then click **Admin → Site feeds → Pull lines** once to fill the board (3 credits). From then on lines come in on the schedule while at least one league exists. Running the same statement with `false` turns the feed off again; **Site feeds** shows which it is.

## 8. Start a league

Anyone signed in can start a league from the league menu (**Start or join a league…**). Its creator is its commissioner. A new league:
- starts on the standard rules (rule set 1, the single-league site's day-one rules), which the commissioner can change for any week that hasn't opened;
- has no week open: the commissioner opens the first one from **Admin → Week**, once its games are on the board;
- gets an invite link (**Admin → League**). People who open it sign in, then join, with an entry of their own at the rules' starting bank unless the commissioner turns that off.

Commissioners have the powers the single-league site gave its admins, for their own league only: rules, entries and managers, bank adjustments, imports, opening and closing weeks, voiding bets, and making other members commissioners.

## 9. Player props (optional)

Props come from the owner's own prop pulls, not from this site's Odds API key. After each run of the owner's **SharpSlate NFL Props** task, a step on the owner's PC (`sync/hub_props.py` in OneStopShop) sends the main lines to this site's `import-props` function. Nothing here needs setting up:
- The sender presents a key, kept on the owner's PC in OneStopShop's `.env.hub` (`HUB_PROPS_URL`, `HUB_PROPS_KEY`). The database keeps only its SHA-256, in `app.prop_import_key`. To change the key, put a new one in `.env.hub` and its hash in that table (SQL editor: `update app.prop_import_key set sha256 = '<hash>';`).
- Props only show for games already on the board, so they wait for the odds feed (step 7).
- A league offers them once its commissioner turns them on (**Admin → Rules → Player props**, from a week that hasn't opened). **Site feeds** shows when props were last pulled; a failed import shows under **Recent problems**.

## During the season

Site admins:
- **A final held for ESPN:** a game goes final only once ESPN's scoreboard agrees with the odds feed. When they disagree, or ESPN can't be reached, **Site feeds → Recent problems** says "final held" and why. Check the real score and enter it with **Games & lines → Correct the final score**.
- **A wrong final score:** **Games & lines → Correct the final score.** Every league's bets on that game are taken back and graded again within 10 minutes.
- **A postponed game:** set it to **Postponed**. Its bets ride in every league. A league's week won't close by itself while the game is unplayed; its commissioner uses **Open next week** to move on.
- **Something looks stuck:** **Site feeds → Recent problems** lists failed pulls, bets the grader couldn't settle, and games that need a hand.
- **Betting closed early on a game that hasn't started:** mark it **Postponed**, **Pull lines**, then set it back to **Scheduled**.
- **A player prop graded void by mistake:** **Recent problems** names any player with props who wasn't in ESPN's box score (his props were graded void as did not play). If he played, enter his stats with **Games & lines → Set a player's stats**; the game's bets are graded again within 10 minutes.

Commissioners:
- **The last week of the season:** after its last game, **Close the season** on **Admin → Week**.
- **An entry changes hands:** **Members → Entry managers.** Make the new manager first, then remove the old one.
- **Fair play:** **Admin → Week → Recent problems** flags two entries of the league that share a manager and took opposite sides of a game, once both picks are public.
