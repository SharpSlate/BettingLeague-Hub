import { useEffect, useState } from "react";
import type { PropMarket } from "@rules";
import { loadPropLab, propLabHref, type PropLabIndex } from "../lib/prop-lab.ts";

/** SharpSlate's Prop Lab player list, read once something on screen needs it (on is true). */
export function usePropLab(on: boolean): PropLabIndex | null {
  const [index, setIndex] = useState<PropLabIndex | null>(null);
  useEffect(() => {
    if (!on) return;
    let live = true;
    void loadPropLab().then((i) => {
      if (live && i) setIndex(i);
    });
    return () => {
      live = false;
    };
  }, [on]);
  return index;
}

/**
 * A player's name, linking to his prop card in SharpSlate's Prop Lab. It always opens in a
 * new tab, so the slip and the board stay as they were.
 */
export function PlayerLink({ player, market, teams, index, className }: {
  player: string;
  market: PropMarket | null;
  /** The game's two teams, full or short names. */
  teams: string[];
  index: PropLabIndex | null;
  className?: string;
}) {
  return (
    <a
      className={`player-link${className ? ` ${className}` : ""}`}
      href={propLabHref(index, player, market, teams)}
      target="_blank"
      rel="noopener noreferrer"
      title={`${player}'s prop card on SharpSlate (opens in a new tab)`}
    >
      {player}
      <span className="sr-only"> (prop card on SharpSlate, opens in a new tab)</span>
    </a>
  );
}
