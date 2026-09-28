import type { ReactNode } from "react";

export function Segmented<T extends string | number>({ value, options, onChange, full, label, disabled }: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  full?: boolean;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <div className={`seg${full ? " full" : ""}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? "on" : ""} disabled={disabled} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const STATUS_TEXT: Record<string, string> = { pending: "Pending", won: "Won", lost: "Lost", push: "Push", void: "Void", undone: "Undone" };

export function StatusChip({ status }: { status: string }) {
  return <span className={`chip ${status}`}>{STATUS_TEXT[status] ?? status}</span>;
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return <div className="empty">{what}…</div>;
}

export function ErrorNote({ error }: { error: string | null }) {
  return error ? <div className="banner bad" role="alert">{error}</div> : null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function PageHead({ title, sub, right }: { title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub ? <p className="muted small">{sub}</p> : null}
      </div>
      {right}
    </div>
  );
}

/** Friendly text for database error codes shown to admins. */
export function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  const map: Record<string, string> = {
    admin_only: "Only admins can do that.",
    reason_required: "Give a reason (at least 3 characters).",
    insufficient_units: "That would take the bank below zero.",
    entry_has_bets: "That entry already has bets here, so it can't be imported.",
    game_started: "That game has started.",
    already_graded: "Bets on that game are already graded.",
    effective_week_must_be_future: "Rule changes must start from a week that hasn't opened yet.",
    next_week_not_loaded: "Next week's games aren't on the board yet, so the week can't close into it. Try again once they are, or, if this is the season's last week, close the season.",
    not_pending: "That bet isn't pending any more.",
    undo_window_passed: "The undo window has passed.",
    spread_points_must_mirror: "The two spread numbers must mirror each other (e.g. −3 and +3).",
    total_points_must_match: "Over and under need the same total.",
    last_admin: "The league needs at least one admin.",
    week_changed: "The open week changed since this page loaded. Reload and check before trying again.",
    week_not_started: "No game this week has kicked off yet, so it can't be closed early.",
    no_week_to_open: "No upcoming week has games on the board yet.",
    week_closed: "That bet's week has closed, so it can't be undone.",
    kickoff_in_past: "A kickoff can't be set in the past.",
    kickoff_passed: "This game's kickoff has passed, so its kickoff can't be changed.",
    kickoff_earlier: "Once a week is open, a kickoff can only move later (moving it earlier would show its picks early). To stop betting on the game now, mark it postponed.",
    next_week_loaded: "Next week's games are on the board, so this isn't the season's last week. Use Open next week.",
    game_void: "That game was voided. Enter its final score to bring its bets back.",
    game_final: "That game is final. Correct its score or void it instead.",
    game_not_started: "That game hasn't kicked off yet.",
    no_change: "That's already the final score.",
    bad_score: "Scores are whole numbers, 0 or more.",
    bad_price: "Prices are American odds from 100 to 100000, plus or minus.",
    bad_point: "Lines are whole or half points.",
    week_already_open: "Only games in a week that hasn't opened yet can be moved.",
    effective_week_before_scheduled: "A rules change is already scheduled for a later week. Start this one from that week or later.",
  };
  return map[m] ?? m;
}
