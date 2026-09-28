# Setting up the site

One-time steps for the owner, roughly in this order. Nothing secret ever goes in this repo or in chat: every key goes into **GitHub Secrets** (repo **Settings → Secrets and variables → Actions**), and the deploy workflow hands it to Supabase.

The menu names below are as of September 2026. If a screen looks different, the Claude session can walk you through it.

## 1. Supabase project

1. At [supabase.com](https://supabase.com), sign in and create a **new project**:
   - name: `baltimore-degenerates`
   - region: East US
   - a strong database password, saved somewhere safe

   The free plan allows two active projects. If you already have two, pause one.
2. From the project's settings, note:
   - the **project ref**: the 20-letter id in the project URL;
   - the **project URL**: `https://<ref>.supabase.co`;
   - the **publishable (anon) key**, which is meant to be public.
3. In your Supabase account settings, create a **personal access token** for the deploy workflow.

## 2. League email for sign-in codes

Supabase's built-in email only reaches the project's own team, so members' sign-in codes need a real sender.

1. Create a Gmail account for the league.
2. Turn on 2-Step Verification for it.
3. Create an **app password**. Google lists it under the account's Security settings.

The deploy works without this, but then only you can get codes. Add it before the commissioner signs in.

## 3. Google sign-in (optional for the trial)

1. In [Google Cloud Console](https://console.cloud.google.com), create an **OAuth client ID** of type *Web application*.
2. Add this authorized redirect URI: `https://<ref>.supabase.co/auth/v1/callback`
3. Note the client ID and client secret.

Until this is set up, the "Continue with Google" button won't work. Emailed codes still will.

## 4. GitHub settings

In **Settings → Secrets and variables → Actions**:

**Variables** tab (these values aren't secret):

| Name | Value |
|---|---|
| `SUPABASE_PROJECT_REF` | the project ref |
| `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | the publishable (anon) key |
| `SITE_URL` | `https://bappel2.github.io/BettingLeague/` |

**Secrets** tab:

| Name | Value |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | the personal access token from step 1 |
| `SUPABASE_DB_PASSWORD` | the database password from step 1 |
| `ODDS_API_KEY` | your The Odds API key |
| `CRON_SECRET` | any long random string (it lets the scheduler call the functions) |
| `SMTP_USER` | the league Gmail address |
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
5. publishes the site to `https://bappel2.github.io/BettingLeague/`.

You can watch it under the repo's **Actions** tab. After this, every merge to `main` redeploys.

## 6. Make yourself the first admin

1. In the Supabase dashboard, open **Authentication → Users** and add a user with your email.
2. In the **SQL editor**, run:
   ```sql
   select app.bootstrap_admin('your-email@example.com');
   ```
3. Sign in on the site with your email (or Google) and open **Admin**.

## 7. Week 4 trial

In **Admin**:
1. **Members:** add the commissioner by email, then make them an admin.
2. **Entries & banks:** add your two entries and the commissioner's with no bank, then **Import from Splash** for each, using Splash's standings after week 3.
3. **Members → Entry managers:** link each entry to its manager.
4. **Week & feeds:** click **Pull lines**, then **Open next week**. That opens week 4.

During the week, copy your Splash bets onto the site. After Monday night, compare the two sites' grading.

## 8. Go-live for week 5

After week 4 finishes on Splash:
1. Add every member (each needs a display name, which everyone sees) and every other entry.
2. Import each of those entries' Splash standings after week 4.
3. Link each entry to its managers.
4. **The trial entries** (yours and the commissioner's) already have their week 4 bets here, so they aren't imported again (the site refuses to import an entry with bets). Compare each one's bank with Splash's after week 4. If one differs, for example because a bet wasn't copied, use **Entries & banks → Adjust a bank** with the reason.

Once week 4's last game is final, week 5 opens on its own.

## During the season

- **A wrong final score:** **Games & lines → Correct the final score.** The site takes back what the game's bets paid and grades them again within 10 minutes. Everyone sees the correction in the admin log.
- **A postponed game:** set it to **Postponed**. Its bets ride. The week won't close by itself while the game is unplayed, so use **Open next week** to move on; the game is graded whenever its final comes in.
- **The last week of the season:** after its last game, click **Close the season** on the Admin page. It closes the week (and applies its 30% minimum) and opens nothing.
- **A bet graded wrong:** enter the game's final score again (**Correct the final score**, same numbers). Its bets are graded again within 10 minutes.
- **Something looks stuck:** **Week & feeds → Recent problems** lists failed line and score pulls and any bet the grader couldn't settle, from the last 3 days. It also flags any game that should have started an hour ago but has no score (if it was postponed, mark it postponed), any game still live 5 hours after kickoff (enter its final score by hand), and any postponed game the feed has stopped checking (enter its final score, or void it).
- **An entry changes hands:** **Members → Entry managers.** Make the new manager first, then remove the old one. While an entry has bets riding, the site won't remove its last manager, and an admin can't add themselves to it; another admin has to.
