import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { RuleSet } from "@rules";
import { Empty, ErrorNote, Loading, PageHead, Segmented } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { clock, day, kickoff, odds, units } from "../lib/format.ts";
import { useLoad } from "../lib/hooks.ts";
import { rulesPage, teaserBreakEvenText, type RuleItem } from "../lib/rules-text.ts";
import type { AuditRow, GameView, WeekInfo } from "../lib/types.ts";

type Tab = "rules" | "schedule" | "entrants" | "log";

export function League() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "rules";
  return (
    <>
      <PageHead title="League" sub="Rules, schedule, entrants, and every admin action." />
      <div className="stack">
        <div className="scroll-x">
          <Segmented<Tab>
            label="Section"
            value={tab}
            onChange={(t) => setParams({ tab: t })}
            options={[{ value: "rules", label: "Rules" }, { value: "schedule", label: "Schedule" }, { value: "entrants", label: "Entrants" }, { value: "log", label: "Admin log" }]}
          />
        </div>
        {tab === "rules" ? <Rules /> : tab === "schedule" ? <Schedule /> : tab === "entrants" ? <Entrants /> : <Log />}
      </div>
    </>
  );
}

export function TeaserTable({ rules }: { rules: RuleSet }) {
  const t = rules.betTypes.teaser;
  // From 2 legs even when a new card needs more: a card cut down by pushes or voids is
  // paid at the row for the legs it has left.
  const legs = Array.from({ length: Math.max(0, t.maxLegs - 1) }, (_, i) => 2 + i);
  return (
    <div className="scroll-x">
      <table className="table teaser-table">
        <thead><tr><th>Legs</th>{t.points.map((p) => <th key={p}>{p} pts</th>)}</tr></thead>
        <tbody>
          {legs.map((n) => (
            <tr key={n}>
              <td>{n}{n < t.minLegs ? <span className="muted"> *</span> : null}</td>
              {t.points.map((p) => <td key={p} className="num">{t.prices[String(p)]?.[String(n)] !== undefined ? odds(t.prices[String(p)]![String(n)]!) : "—"}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {t.minLegs > 2 ? <p className="small muted" style={{ margin: "8px 12px" }}>* Only for cards cut down by pushes or voids; a new card needs at least {t.minLegs} legs.</p> : null}
    </div>
  );
}

function Item({ item }: { item: RuleItem }) {
  return typeof item === "string" ? <li>{item}</li> : <li><b>{item.lead}</b> {item.text}</li>;
}

function Rules() {
  const api = useApi();
  const league = useLoad(() => api.league(), []);
  const versions = useLoad(() => api.ruleVersions(), []);
  const [pick, setPick] = useState<number | null>(null);
  if (versions.loading && !versions.data) return <Loading />;
  const inForce = league.data?.openWeek?.ruleSetVersion ?? versions.data?.at(-1)?.version;
  const shown = versions.data?.find((v) => v.version === (pick ?? inForce)) ?? versions.data?.[0];
  if (!shown) return <Empty>No rules published yet.</Empty>;
  const lg = league.data;
  const page = rulesPage(shown.document, lg ?? null);
  const breakEven = teaserBreakEvenText(shown.document);
  // Scrolls rather than using #anchors, which the site's router would read as a page.
  const go = (id: string) => document.getElementById(`rules-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <div className="stack rules">
      <div className="card pad row wrap spread">
        <div>
          <b>Version {shown.version}</b>{shown.version === inForce ? <span className="chip pending" style={{ marginLeft: 8 }}>In force{lg?.openWeek ? ` for ${lg.openWeek.label}` : ""}</span> : null}
          <div className="small muted">Effective from week {shown.effectiveWeek}. {shown.note}</div>
        </div>
        {versions.data && versions.data.length > 1 ? (
          <select className="input" style={{ width: "auto" }} value={shown.version} onChange={(e) => setPick(Number(e.target.value))} aria-label="Rules version">
            {versions.data.map((v) => <option key={v.version} value={v.version}>Version {v.version} (from week {v.effectiveWeek})</option>)}
          </select>
        ) : null}
      </div>

      <section className="card pad rule-section" aria-labelledby="rules-glance">
        <h2 id="rules-glance">At a glance</h2>
        <dl className="glance">
          {page.glance.map((g) => (
            <div key={g.label} className="glance-item">
              <dt>{g.label}</dt>
              <dd><b>{g.value}</b>{g.detail ? <span>{g.detail}</span> : null}</dd>
            </div>
          ))}
        </dl>
      </section>

      <nav className="toc" aria-label="Jump to a section">
        {page.sections.map((s) => <button key={s.id} type="button" onClick={() => go(s.id)}>{s.title}</button>)}
      </nav>

      {page.sections.map((s) => (
        <section key={s.id} id={`rules-${s.id}`} className="card pad rule-section" aria-labelledby={`rules-${s.id}-title`}>
          <h2 id={`rules-${s.id}-title`}>{s.title}</h2>
          {s.intro ? <p className="muted">{s.intro}</p> : null}
          <ul>{s.items.map((i) => <Item key={typeof i === "string" ? i : i.lead} item={i} />)}</ul>
          {s.example ? <p className="example"><b>Example.</b> {s.example}</p> : null}
          {s.id === "bets" && shown.document.betTypes.teaser.enabled ? (
            <div className="stack-sm">
              <h3>Teaser prices</h3>
              <div className="card flat"><TeaserTable rules={shown.document} /></div>
              {breakEven ? <p className="small muted">{breakEven}</p> : null}
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}

function Schedule() {
  const api = useApi();
  const weeks = useLoad(() => api.weeks(), []);
  const [open, setOpen] = useState<number | null>(null);
  if (weeks.loading && !weeks.data) return <Loading />;
  const current = weeks.data?.find((w) => w.status === "open")?.week;
  const shown = open ?? current ?? null;
  return (
    <div className="stack">
      {(weeks.data ?? []).map((w) => (
        <details key={w.week} className="card" open={w.week === shown} onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && setOpen(w.week)}>
          <summary className="row spread">
            <span>{w.label}</span>
            <span className={`chip ${w.status === "open" ? "pending" : ""}`}>{w.status === "open" ? "Open" : w.status === "closed" ? "Closed" : "Upcoming"}</span>
          </summary>
          {w.week === shown ? <WeekGames week={w} /> : null}
        </details>
      ))}
    </div>
  );
}

function WeekGames({ week }: { week: WeekInfo }) {
  const api = useApi();
  const games = useLoad(() => api.games(week.week), [week.week]);
  if (games.loading && !games.data) return <div className="body"><Loading /></div>;
  const list: GameView[] = games.data ?? [];
  return (
    <div className="body stack-sm">
      <div className="small muted">{day(week.startsAt)} to {day(new Date(Date.parse(week.endsAt) - 1).toISOString())}</div>
      {list.length === 0 ? <div className="small muted">Games appear here once lines are posted.</div> : list.map((g) => (
        <div key={g.id} className="row spread small">
          <span>{g.away.shortName} at {g.home.shortName}</span>
          <span className="num muted">{g.status === "final" ? `${g.awayScore}–${g.homeScore} F` : g.status === "live" ? `${g.awayScore}–${g.homeScore} live` : g.status === "scheduled" ? `${day(g.kickoffAt).split(",")[0]} ${clock(g.kickoffAt)}` : g.status}</span>
        </div>
      ))}
    </div>
  );
}

function Entrants() {
  const api = useApi();
  const list = useLoad(() => api.entrants(), []);
  if (list.loading && !list.data) return <Loading />;
  return (
    <div className="card feed">
      {(list.data ?? []).map((e) => (
        <div className="feed-item" key={e.entryId}>
          <b>{e.name}</b>
          <span className="when">{e.managers.join(", ") || "No manager yet"}</span>
        </div>
      ))}
    </div>
  );
}

const ACTIONS: Record<string, string> = {
  week_opened: "opened the week",
  week_closed: "closed the week",
  week_opened_note: "noted on opening the week",
  entry_added: "added an entry",
  manager_added: "added an entry manager",
  manager_removed: "removed an entry manager",
  admin_granted: "made someone an admin",
  admin_removed: "removed an admin",
  member_added: "added a member",
  splash_import: "imported Splash standings",
  bank_adjusted: "adjusted a bank",
  line_set: "set a line",
  line_cleared: "cleared a line override",
  game_status_set: "changed a game's status",
  score_set: "entered a final score",
  score_corrected: "corrected a final score",
  bets_regraded: "regraded a game's bets",
  game_moved: "moved a game to another week",
  bet_voided: "voided a bet",
  rules_published: "published new rules",
  score_mismatch: "flagged a score mismatch",
};

const STATUS_WORD: Record<string, string> = { scheduled: "scheduled", postponed: "postponed", void: "void", live: "live", final: "final" };

function detail(r: AuditRow): string {
  const a = r.after as Record<string, unknown> | null;
  const b = r.before as Record<string, unknown> | null;
  if (!a) return "";
  const regraded = typeof a.betsRegraded === "number" && a.betsRegraded > 0 ? `; ${a.betsRegraded} graded bet${a.betsRegraded === 1 ? "" : "s"} regraded` : "";
  if (r.action === "game_status_set") {
    const parts = [`${STATUS_WORD[String(b?.status)] ?? b?.status ?? "?"} → ${STATUS_WORD[String(a.status)] ?? a.status}`];
    if (typeof a.kickoffAt === "string" && typeof b?.kickoffAt === "string" && Date.parse(a.kickoffAt) !== Date.parse(b.kickoffAt)) {
      parts.push(`kickoff ${kickoff(b.kickoffAt)} → ${kickoff(a.kickoffAt)}`);
    }
    return parts.join(", ") + regraded;
  }
  if (r.action === "score_corrected" && b) return `${b.away}–${b.home} → ${a.away}–${a.home} (away–home)${regraded}`;
  if (r.action === "bets_regraded") return `${a.away}–${a.home} (away–home)${regraded}`;
  if ((r.action === "manager_added" || r.action === "manager_removed") && typeof a.member === "string") return `${a.member}, ${a.entry}`;
  if (r.action === "week_closed") return `week ${a.closed}`;
  if (r.action === "bank_adjusted" && typeof a.amountCents === "number") return `${a.amountCents > 0 ? "+" : ""}${units(a.amountCents)} units`;
  if (r.action === "rules_published") return `version ${a.version}, from week ${a.effectiveWeek}`;
  if (r.action === "week_opened") return `week ${a.opened}`;
  if (r.action === "splash_import" && typeof a.bankCents === "number") return `bank ${units(a.bankCents)}`;
  if (r.action === "score_set" || r.action === "score_mismatch") return `${a.away}–${a.home} (away–home)`;
  return "";
}

function Log() {
  const api = useApi();
  const log = useLoad(() => api.auditLog(300), []);
  if (log.loading && !log.data) return <Loading />;
  return (
    <>
      <ErrorNote error={log.error} />
      <div className="card feed">
        {(log.data ?? []).length === 0 ? <Empty>No admin actions yet.</Empty> : log.data!.map((r) => (
          <div className="feed-item" key={r.id}>
            <div className="grow">
              <div><b>{r.actorName ?? "The site"}</b> {ACTIONS[r.action] ?? r.action}{detail(r) ? `: ${detail(r)}` : ""}</div>
              {r.reason ? <div className="tiny muted">“{r.reason}”</div> : null}
            </div>
            <span className="when">{kickoff(r.createdAt)}</span>
          </div>
        ))}
      </div>
    </>
  );
}
