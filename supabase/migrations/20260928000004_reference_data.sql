-- Reference data: league settings, the 32 teams (named as the Odds API names them),
-- the season's week windows, and the day-one rule set as version 1.

insert into public.league_settings (id) values (true);

insert into public.teams (abbr, name, short_name) values
  ('ARI', 'Arizona Cardinals', 'Cardinals'),
  ('ATL', 'Atlanta Falcons', 'Falcons'),
  ('BAL', 'Baltimore Ravens', 'Ravens'),
  ('BUF', 'Buffalo Bills', 'Bills'),
  ('CAR', 'Carolina Panthers', 'Panthers'),
  ('CHI', 'Chicago Bears', 'Bears'),
  ('CIN', 'Cincinnati Bengals', 'Bengals'),
  ('CLE', 'Cleveland Browns', 'Browns'),
  ('DAL', 'Dallas Cowboys', 'Cowboys'),
  ('DEN', 'Denver Broncos', 'Broncos'),
  ('DET', 'Detroit Lions', 'Lions'),
  ('GB', 'Green Bay Packers', 'Packers'),
  ('HOU', 'Houston Texans', 'Texans'),
  ('IND', 'Indianapolis Colts', 'Colts'),
  ('JAX', 'Jacksonville Jaguars', 'Jaguars'),
  ('KC', 'Kansas City Chiefs', 'Chiefs'),
  ('LV', 'Las Vegas Raiders', 'Raiders'),
  ('LAC', 'Los Angeles Chargers', 'Chargers'),
  ('LAR', 'Los Angeles Rams', 'Rams'),
  ('MIA', 'Miami Dolphins', 'Dolphins'),
  ('MIN', 'Minnesota Vikings', 'Vikings'),
  ('NE', 'New England Patriots', 'Patriots'),
  ('NO', 'New Orleans Saints', 'Saints'),
  ('NYG', 'New York Giants', 'Giants'),
  ('NYJ', 'New York Jets', 'Jets'),
  ('PHI', 'Philadelphia Eagles', 'Eagles'),
  ('PIT', 'Pittsburgh Steelers', 'Steelers'),
  ('SF', 'San Francisco 49ers', '49ers'),
  ('SEA', 'Seattle Seahawks', 'Seahawks'),
  ('TB', 'Tampa Bay Buccaneers', 'Buccaneers'),
  ('TEN', 'Tennessee Titans', 'Titans'),
  ('WAS', 'Washington Commanders', 'Commanders');

-- Weeks run Tuesday to Monday, Eastern time. Week 1 of 2026 started Tuesday, Sept 8.
-- 19-21 are the first three playoff rounds. The Super Bowl falls in 22 or 23; the
-- week-advance logic skips any week without games.
insert into public.weeks (week, label, starts_at, ends_at)
select w,
       case
         when w <= 18 then 'Week ' || w
         when w = 19 then 'Wild Card'
         when w = 20 then 'Divisional'
         when w = 21 then 'Conference Championships'
         else 'Super Bowl'
       end,
       ((date '2026-09-08' + (w - 1) * 7)::timestamp at time zone 'America/New_York'),
       ((date '2026-09-08' + w * 7)::timestamp at time zone 'America/New_York')
from generate_series(1, 23) as w;

-- Generated from DAY_ONE_RULES in supabase/functions/_shared/rules/defaults.ts
-- (node scripts/print-day-one-rules.ts). A test checks the two match.
insert into public.rule_sets (version, effective_week, document, note) values (1, 1, $rules$
{
  "betTypes": {
    "straight": {
      "enabled": true,
      "markets": [
        "spread",
        "total",
        "moneyline"
      ]
    },
    "parlay": {
      "enabled": true,
      "minLegs": 2,
      "maxLegs": 10,
      "markets": [
        "spread",
        "total",
        "moneyline"
      ],
      "sameGame": {
        "spreadTotal": true,
        "moneylineTotal": true,
        "spreadMoneyline": false,
        "bothSides": false
      }
    },
    "teaser": {
      "enabled": true,
      "minLegs": 2,
      "maxLegs": 10,
      "markets": [
        "spread",
        "total"
      ],
      "points": [
        6,
        6.5,
        7
      ],
      "prices": {
        "6": {
          "2": -110,
          "3": 180,
          "4": 290,
          "5": 455,
          "6": 680,
          "7": 1000,
          "8": 1450,
          "9": 2050,
          "10": 2950
        },
        "7": {
          "2": -130,
          "3": 140,
          "4": 220,
          "5": 330,
          "6": 475,
          "7": 670,
          "8": 930,
          "9": 1250,
          "10": 1750
        },
        "6.5": {
          "2": -120,
          "3": 160,
          "4": 255,
          "5": 390,
          "6": 570,
          "7": 820,
          "8": 1150,
          "9": 1650,
          "10": 2300
        }
      },
      "pushRule": "reduce",
      "totalsNeedSpread": false,
      "sameGame": {
        "spreadTotal": true,
        "moneylineTotal": true,
        "spreadMoneyline": true,
        "bothSides": true
      }
    }
  },
  "pricing": {
    "straight": "book",
    "flatPrice": -110
  },
  "stake": {
    "minUnits": 1,
    "maxUnits": 250000,
    "incrementUnits": 1,
    "maxPctOfBank": null
  },
  "undoMinutes": 5,
  "weeklyMinimum": {
    "pct": 30,
    "penalty": "deduct_shortfall"
  },
  "visibility": "kickoff_per_leg",
  "lock": "game_kickoff",
  "bank": {
    "startUnits": 10000,
    "bonusUnits": 5000
  }
}
$rules$::jsonb, 'Day-one rules agreed on 2026-09-28 (see DECISIONS.md).');
