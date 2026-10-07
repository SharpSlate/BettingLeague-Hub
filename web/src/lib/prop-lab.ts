// Links from a player prop to that player's card in SharpSlate's NFL Prop Lab (owner,
// 2026-10-07: "can a user click on that player and view their prop card in the regular
// site? ... make sure it opens in a new tab so they dont lose whatever slip they are
// working on").
//
// The Prop Lab opens a card from its URL hash, #g=<game key>&t=<team>&p=<player id>&m=<market>,
// and only finds a player inside the game and team the hash names. Our props carry just the
// books' name for the player, so the site reads the Prop Lab's own published player list
// (the file the Prop Lab page itself loads) to turn a name into those keys. When the list
// can't be read, or the player isn't on it, the link still opens the Prop Lab: on the game
// when that's on its slate, else on its front page.
import type { PropMarket } from "@rules";

export const PROP_LAB_URL = "https://sharpslatesports.com/nfl/prop-lab/";
export const PROP_LAB_DATA_URL = "https://sharpslatesports.com/data/nfl/prop-lab.json";

/** Our prop markets under the Odds API keys the Prop Lab uses. */
const LAB_MARKET: Record<PropMarket, string> = {
  anytime_td: "player_anytime_td",
  receptions: "player_receptions",
  rush_yds: "player_rush_yds",
  rec_yds: "player_reception_yds",
  pass_yds: "player_pass_yds",
};

interface LabGame { key: string; teams: string[] }
interface LabPlayer { id: string; team: string; game: LabGame; name: string }

export interface PropLabIndex {
  games: LabGame[];
  /** Players by nameKey(). */
  byName: Map<string, LabPlayer[]>;
}

/**
 * A player's name in a form both sides agree on: no accents, case, periods or apostrophes,
 * no Jr./Sr./II-V, and initials run together ("D. J. Moore", "D.J. Moore" and "DJ Moore"
 * are all "dj moore"; "Aaron Jones Sr." is "aaron jones").
 */
export function nameKey(name: string): string {
  let s = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[.'’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  s = s.replace(/(?:\s+(?:jr|sr|ii|iii|iv|v))+$/, "");
  return s.replace(/\b([a-z]) (?=[a-z]\b)/g, "$1");
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Reads the Prop Lab's published file; anything malformed in it is skipped. */
export function buildIndex(data: unknown): PropLabIndex {
  const d = (data ?? {}) as { slate?: { games?: unknown }; players?: unknown };
  const rawGames = Array.isArray(d.slate?.games) ? (d.slate.games as Record<string, unknown>[]) : [];
  const games = new Map<string, LabGame>();
  for (const g of rawGames) {
    if (g && str(g.key)) games.set(g.key, { key: g.key, teams: [g.away_name, g.home_name].filter(str) });
  }
  const byName = new Map<string, LabPlayer[]>();
  for (const p of Array.isArray(d.players) ? (d.players as Record<string, unknown>[]) : []) {
    if (!p || !str(p.id) || !str(p.name) || !str(p.team) || !str(p.game)) continue;
    const game = games.get(p.game);
    if (!game) continue;
    const k = nameKey(p.name);
    if (!k) continue;
    byName.set(k, [...(byName.get(k) ?? []), { id: p.id, team: p.team, game, name: p.name }]);
  }
  return { games: [...games.values()], byName };
}

/** "Los Angeles Rams" answers to "Los Angeles Rams" or "Rams". */
function sameTeam(full: string, name: string): boolean {
  const a = full.toLowerCase();
  const b = name.trim().toLowerCase();
  return !!b && (a === b || a.endsWith(` ${b}`));
}

/** The Prop Lab game with these two teams (full or short names), in either order. */
function findGame(index: PropLabIndex, teams: string[]): LabGame | undefined {
  const named = teams.filter(Boolean);
  if (named.length < 2) return undefined;
  return index.games.find((g) => named.every((t) => g.teams.some((full) => sameTeam(full, t))));
}

function findPlayer(index: PropLabIndex, player: string, game: LabGame | undefined): LabPlayer | undefined {
  const k = nameKey(player);
  const same = index.byName.get(k) ?? [];
  // Our game isn't on the Prop Lab's slate (it has moved on to the next week): a name it
  // lists once is still him.
  if (!game) return same.length === 1 ? same[0] : undefined;
  const inGame = same.filter((p) => p.game.key === game.key);
  if (inGame.length) return inGame.length === 1 ? inGame[0] : undefined;
  // The books and the Prop Lab can spell a first name differently ("Gabe" and "Gabriel"
  // Davis): within the game, one player with his last name and first initial is him.
  const words = k.split(" ");
  const first = words[0]?.[0];
  const last = words[words.length - 1];
  if (words.length < 2 || !first || !last) return undefined;
  const near: LabPlayer[] = [];
  for (const list of index.byName.values()) {
    for (const p of list) {
      if (p.game.key !== game.key) continue;
      const w = nameKey(p.name).split(" ");
      if (w.length >= 2 && w[0]![0] === first && w[w.length - 1] === last) near.push(p);
    }
  }
  return near.length === 1 ? near[0] : undefined;
}

/**
 * The Prop Lab link for a player's prop. teams are the game's two teams (full or short
 * names). Without the index (not loaded yet, or unreadable) it's the Prop Lab's front page.
 */
export function propLabHref(index: PropLabIndex | null, player: string, market: PropMarket | null, teams: string[]): string {
  if (!index) return PROP_LAB_URL;
  const game = findGame(index, teams);
  const p = findPlayer(index, player, game);
  const enc = encodeURIComponent;
  if (p) {
    const m = market ? LAB_MARKET[market] : undefined;
    return `${PROP_LAB_URL}#g=${enc(p.game.key)}&t=${enc(p.team)}&p=${enc(p.id)}${m ? `&m=${enc(m)}` : ""}`;
  }
  return game ? `${PROP_LAB_URL}#g=${enc(game.key)}` : PROP_LAB_URL;
}

// ---------------------------------------------------------------- loading

/** Reloaded after this long, so a page left open picks up the Prop Lab's next slate. */
const KEEP_MS = 3 * 60 * 60 * 1000;
/** After a failed read, wait this long before trying again. */
const RETRY_MS = 5 * 60 * 1000;

let cached: { index: PropLabIndex; at: number } | null = null;
let pending: Promise<PropLabIndex | null> | null = null;
let failedAt = 0;

/** The Prop Lab's player list, read once and shared; null when it can't be read. */
export function loadPropLab(now = Date.now()): Promise<PropLabIndex | null> {
  if (cached && now - cached.at < KEEP_MS) return Promise.resolve(cached.index);
  if (pending) return pending;
  if (now - failedAt < RETRY_MS) return Promise.resolve(cached?.index ?? null);
  pending = fetch(PROP_LAB_DATA_URL, { credentials: "omit" })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Prop Lab answered ${r.status}`))))
    .then((data) => {
      const index = buildIndex(data);
      cached = { index, at: Date.now() };
      return index;
    })
    .catch(() => {
      failedAt = Date.now();
      return cached?.index ?? null;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}
