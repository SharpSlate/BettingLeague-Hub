import { effectivePrice, type Market, type RuleSet, type Side } from "@rules";
import { ago, clock, odds, pickLabel, point } from "../lib/format.ts";
import { pickKey, useSlip } from "../lib/slip.tsx";
import type { GameView, LineView } from "../lib/types.ts";

const BOOK = { draftkings: "DraftKings", fanduel: "FanDuel", override: "Commissioner line" } as Record<string, string>;

export function bookName(source: string): string {
  return BOOK[source] ?? source;
}

function PriceButton({ game, line, market, side, rules }: { game: GameView; line: LineView | undefined; market: Market; side: Side; rules?: RuleSet }) {
  const slip = useSlip();
  if (!line) {
    return <button type="button" className="price" disabled aria-label="Not offered"><span className="p2">—</span></button>;
  }
  const key = pickKey(game.id, market, side);
  const on = slip.has(key);
  // Under flat pricing, spreads and totals pay the league's flat price, not the book's.
  const price = rules ? effectivePrice(market, line.price, rules) : line.price;
  const top = market === "moneyline" ? odds(price) : market === "total" ? `${side === "over" ? "O" : "U"} ${line.point}` : point(line.point ?? 0);
  const bottom = market === "moneyline" ? "" : odds(price);
  const label = pickLabel(game, market, side, line.point);
  return (
    <button
      type="button"
      className={`price${on ? " on" : ""}`}
      aria-pressed={on}
      aria-label={`${label} ${odds(price)}`}
      disabled={slip.status.busy}
      onClick={() =>
        slip.toggle({
          key, gameId: game.id, market, side, point: line.point, price,
          home: game.home.shortName, away: game.away.shortName, kickoffAt: game.kickoffAt,
        })
      }
    >
      <span className="p1 num">{top}</span>
      {bottom ? <span className="p2 num">{bottom}</span> : null}
    </button>
  );
}

export function GameCard({ game, now, rules }: { game: GameView; now: number; rules?: RuleSet }) {
  const started = game.status !== "scheduled" || new Date(game.locksAt).getTime() <= now;
  const line = (market: Market, side: Side) => game.lines.find((l) => l.market === market && l.side === side);
  const sources = [...new Set(game.lines.map((l) => l.source))];
  const asOf = game.lines.reduce<string | null>((a, l) => (!a || l.asOf > a ? l.asOf : a), null);

  const status =
    game.status === "live" ? <span className="chip live">Live</span>
    : game.status === "final" ? <span className="chip">Final</span>
    : game.status === "postponed" ? <span className="chip">Postponed</span>
    : game.status === "void" ? <span className="chip void">Void</span>
    : started ? <span className="chip live">Started</span>
    : null;

  const teamRow = (side: "away" | "home") => {
    const t = side === "home" ? game.home : game.away;
    const score = side === "home" ? game.homeScore : game.awayScore;
    return (
      <div className="team">
        <span className="abbr">{t.abbr}</span>
        <span className="nm">{t.shortName}</span>
        {started && score !== null ? <span className="score num">{score}</span> : null}
      </div>
    );
  };

  return (
    <article className={`card game${started ? " locked" : ""}`} aria-label={`${game.away.name} at ${game.home.name}`}>
      <div className="game-top">
        <span className="num">
          {clock(game.kickoffAt)}
          {!started && sources.length ? ` · ${sources.map(bookName).join(" / ")}` : ""}
          {!started && asOf ? ` · ${ago(asOf, now)}` : ""}
        </span>
        {status}
      </div>
      {started ? (
        <div className="game-final">
          {teamRow("away")}
          {teamRow("home")}
          <div className="tiny muted">Locked at kickoff. Picks on this game are now visible in League Picks.</div>
        </div>
      ) : (
        <div className="game-grid">
          <span />
          <span className="colhead">Spread</span>
          <span className="colhead">Total</span>
          <span className="colhead">Money</span>
          {teamRow("away")}
          <PriceButton game={game} rules={rules} line={line("spread", "away")} market="spread" side="away" />
          <PriceButton game={game} rules={rules} line={line("total", "over")} market="total" side="over" />
          <PriceButton game={game} rules={rules} line={line("moneyline", "away")} market="moneyline" side="away" />
          {teamRow("home")}
          <PriceButton game={game} rules={rules} line={line("spread", "home")} market="spread" side="home" />
          <PriceButton game={game} rules={rules} line={line("total", "under")} market="total" side="under" />
          <PriceButton game={game} rules={rules} line={line("moneyline", "home")} market="moneyline" side="home" />
        </div>
      )}
    </article>
  );
}
