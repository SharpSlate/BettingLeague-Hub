# Odds API fixtures

Sample responses in The Odds API v4 format (`/v4/sports/americanfootball_nfl/odds`
with `oddsFormat=american`, and `/scores` with `daysFrom=1`), written by hand from the
documented format because the build session can't reach the API. Team names, prices and
ids are made up. Replace or extend them with real responses once the first live pull runs.

# ESPN fixture

`espn-summary.json` is an NFL game summary (`site.api.espn.com/.../nfl/summary?event=`)
trimmed to the box score fields parseBox reads, written by hand from ESPN's format (checked
against a saved college football box score, which has the same shape). The players are
real; their stats are made up.
