// The 32 teams, for the demo. The real site reads them from the database.
import type { Team } from "./types.ts";

const T: [string, string, string][] = [
  ["ARI", "Arizona Cardinals", "Cardinals"], ["ATL", "Atlanta Falcons", "Falcons"], ["BAL", "Baltimore Ravens", "Ravens"],
  ["BUF", "Buffalo Bills", "Bills"], ["CAR", "Carolina Panthers", "Panthers"], ["CHI", "Chicago Bears", "Bears"],
  ["CIN", "Cincinnati Bengals", "Bengals"], ["CLE", "Cleveland Browns", "Browns"], ["DAL", "Dallas Cowboys", "Cowboys"],
  ["DEN", "Denver Broncos", "Broncos"], ["DET", "Detroit Lions", "Lions"], ["GB", "Green Bay Packers", "Packers"],
  ["HOU", "Houston Texans", "Texans"], ["IND", "Indianapolis Colts", "Colts"], ["JAX", "Jacksonville Jaguars", "Jaguars"],
  ["KC", "Kansas City Chiefs", "Chiefs"], ["LV", "Las Vegas Raiders", "Raiders"], ["LAC", "Los Angeles Chargers", "Chargers"],
  ["LAR", "Los Angeles Rams", "Rams"], ["MIA", "Miami Dolphins", "Dolphins"], ["MIN", "Minnesota Vikings", "Vikings"],
  ["NE", "New England Patriots", "Patriots"], ["NO", "New Orleans Saints", "Saints"], ["NYG", "New York Giants", "Giants"],
  ["NYJ", "New York Jets", "Jets"], ["PHI", "Philadelphia Eagles", "Eagles"], ["PIT", "Pittsburgh Steelers", "Steelers"],
  ["SF", "San Francisco 49ers", "49ers"], ["SEA", "Seattle Seahawks", "Seahawks"], ["TB", "Tampa Bay Buccaneers", "Buccaneers"],
  ["TEN", "Tennessee Titans", "Titans"], ["WAS", "Washington Commanders", "Commanders"],
];

export const TEAMS: Team[] = T.map(([abbr, name, shortName]) => ({ abbr, name, shortName }));
export const team = (abbr: string): Team => TEAMS.find((t) => t.abbr === abbr)!;
