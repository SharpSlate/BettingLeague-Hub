// Box scores sent from the site owner's PC (import-boxes): ESPN's own game summaries,
// which the PC can read when ESPN refuses the site's requests. Pure code, so it runs in
// the Edge Function and in the tests.
import { findEspnGame, parseBox, parseEspn, type BoxPlayer, type EspnGame } from "./espn.ts";
import type { BoxNeeded } from "./jobs.ts";

export interface FeedBox {
  gameId: string;
  espnId: string;
  players: BoxPlayer[];
}

/** A summary's game (its header, read like a scoreboard event) and players, or null if it's malformed. */
function readSummary(summary: unknown): { game: EspnGame; players: BoxPlayer[] } | null {
  const header = (summary as { header?: { id?: unknown; competitions?: unknown[] } } | null)?.header;
  const comp = Array.isArray(header?.competitions) ? (header.competitions[0] as { date?: unknown } | undefined) : undefined;
  if (!header || !comp) return null;
  const [game] = parseEspn({ events: [{ id: header.id, date: comp.date, competitions: [comp] }] });
  return game ? { game, players: parseBox(summary) } : null;
}

/**
 * The box scores to store: each game waiting for one (`need`) matched to a summary of
 * the same two teams starting within 12 hours, once ESPN shows it final with players in
 * its box score. Summaries for other games are ignored.
 */
export function matchFeedBoxes(summaries: unknown[], need: BoxNeeded[]): FeedBox[] {
  const read = summaries.flatMap((s) => {
    const r = readSummary(s);
    return r && r.game.completed && r.game.id && r.players.length ? [r] : [];
  });
  const games = read.map((r) => r.game);
  const out: FeedBox[] = [];
  for (const g of need) {
    const match = findEspnGame(games, g.homeName, g.awayName, g.kickoffAt);
    const hit = match && read.find((r) => r.game === match);
    if (hit) out.push({ gameId: g.gameId, espnId: hit.game.id, players: hit.players });
  }
  return out;
}
