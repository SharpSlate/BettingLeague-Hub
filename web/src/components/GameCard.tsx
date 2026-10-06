import { activeProps, effectivePrice, PROP_LABEL, PROP_MARKETS, type Market, type PropMarket, type RuleSet, type Side } from "@rules";
import { ago, clock, odds, pickLabel, point } from "../lib/format.ts";
import { pickKey, useSlip } from "../lib/slip.tsx";
import type { GameView, LineView, PropView } from "../lib/types.ts";

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

function PropButton({ game, prop, disabled }: { game: GameView; prop: PropView | undefined; disabled: boolean }) {
  const slip = useSlip();
  if (!prop) {
    return <button type="button" className="price" disabled aria-label="Not offered"><span className="p2">—</span></button>;
  }
  const key = pickKey(game.id, prop.market, prop.side, prop.player);
  const on = slip.has(key);
  const top = prop.side === "yes" ? "Yes" : `${prop.side === "over" ? "O" : "U"} ${prop.point}`;
  return (
    <button
      type="button"
      className={`price${on ? " on" : ""}`}
      aria-pressed={on}
      aria-label={`${pickLabel(game, prop.market, prop.side, prop.point, prop.player)} ${odds(prop.price)}`}
      disabled={slip.status.busy || (disabled && !on)}
      onClick={() =>
        slip.toggle({
          key, gameId: game.id, market: prop.market, side: prop.side, point: prop.point, price: prop.price, player: prop.player,
          home: game.home.shortName, away: game.away.shortName, kickoffAt: game.kickoffAt,
        })
      }
    >
      <span className="p1 num">{top}</span>
      <span className="p2 num">{odds(prop.price)}</span>
    </button>
  );
}

/**
 * The game's player props, by market, when the league offers them. closed says why they
 * can't be bet right now: too old ("stale"), or pulled before the game's inactive players
 * were announced ("inactives").
 */
function Props({ game, markets, closed, now }: { game: GameView; markets: PropMarket[]; closed: "stale" | "inactives" | null; now: number }) {
  const stale = closed !== null;
  const groups = PROP_MARKETS.filter((m) => markets.includes(m))
    .map((m) => ({ market: m, players: [...new Set(game.props.filter((p) => p.market === m).map((p) => p.player))] }))
    .filter((g) => g.players.length);
  if (!groups.length) return null;
  const asOf = game.props.reduce<string | null>((a, p) => (!a || p.asOf > a ? p.asOf : a), null);
  const find = (market: PropMarket, player: string, side: Side) => game.props.find((p) => p.market === market && p.player === player && p.side === side);
  return (
    <details className="props">
      <summary>
        Player props <span className="muted">· {groups.reduce((a, g) => a + g.players.length, 0)}</span>
      </summary>
      <div className="tiny muted" style={{ margin: "6px 0" }}>
        {closed === "inactives"
          ? "This game's inactive players have been announced since these were pulled, so they can't be bet until the next update."
          : closed === "stale" ? "These are out of date and can't be bet until the next update." : `Pulled ${ago(asOf, now)}.`}
      </div>
      {groups.map(({ market, players }) => (
        <div key={market} className="prop-grid">
          <span className="colhead prop-head">{PROP_LABEL[market]}</span>
          {market === "anytime_td" ? <><span className="colhead">Yes</span><span /></> : (
            <>
              <span className="colhead">Over</span>
              <span className="colhead">Under</span>
            </>
          )}
          {players.map((player) => (
            <div key={player} className="prop-row" style={{ display: "contents" }}>
              <span className="prop-player">{player}</span>
              {market === "anytime_td" ? (
                <>
                  <PropButton game={game} prop={find(market, player, "yes")} disabled={stale} />
                  <span />
                </>
              ) : (
                <>
                  <PropButton game={game} prop={find(market, player, "over")} disabled={stale} />
                  <PropButton game={game} prop={find(market, player, "under")} disabled={stale} />
                </>
              )}
            </div>
          ))}
        </div>
      ))}
    </details>
  );
}

export function GameCard({ game, now, rules, propsClosed = null }: { game: GameView; now: number; rules?: RuleSet; propsClosed?: "stale" | "inactives" | null }) {
  // Picks show once a game kicks off (its kickoff passes, or its scores start coming in).
  const kicked = game.status === "live" || game.status === "final" || new Date(game.kickoffAt).getTime() <= now;
  const started = game.status !== "scheduled" || kicked;
  // Betting can close before the kickoff here, when the odds feed shows the game starting;
  // its picks still wait for the kickoff (or its first score).
  const locked = started || new Date(game.locksAt).getTime() <= now;
  const line = (market: Market, side: Side) => game.lines.find((l) => l.market === market && l.side === side);
  const sources = [...new Set(game.lines.map((l) => l.source))];
  const asOf = game.lines.reduce<string | null>((a, l) => (!a || l.asOf > a ? l.asOf : a), null);

  const status =
    game.status === "live" ? <span className="chip live">Live</span>
    : game.status === "final" ? <span className="chip">Final</span>
    : game.status === "postponed" ? <span className="chip">Postponed</span>
    : game.status === "void" ? <span className="chip void">Void</span>
    : started ? <span className="chip live">Started</span>
    : locked ? <span className="chip">Closed</span>
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
    <article className={`card game${locked ? " locked" : ""}`} aria-label={`${game.away.name} at ${game.home.name}`}>
      <div className="game-top">
        <span className="num">
          {clock(game.kickoffAt)}
          {!locked && sources.length ? ` · ${sources.map(bookName).join(" / ")}` : ""}
          {!locked && asOf ? ` · ${ago(asOf, now)}` : ""}
        </span>
        {status}
      </div>
      {locked ? (
        <div className="game-final">
          {teamRow("away")}
          {teamRow("home")}
          <div className="tiny muted">
            {kicked ? "Locked at kickoff. Picks on this game are now visible in League Picks."
              : game.status === "postponed" ? "Postponed. Betting on it is closed for now; picks on it show at kickoff."
              : game.status === "void" ? "Called off. Bets on it are void."
              : "Betting has closed: the odds feed shows this game starting. Picks on it show at kickoff."}
          </div>
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
      {!locked && rules && activeProps(rules) && game.props.length ? (
        <Props game={game} markets={activeProps(rules)!.markets} closed={propsClosed} now={now} />
      ) : null}
    </article>
  );
}
