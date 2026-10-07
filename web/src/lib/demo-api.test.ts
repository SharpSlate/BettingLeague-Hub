import { afterEach, describe, expect, it, vi } from "vitest";
import { DemoApi } from "./demo-api.ts";

afterEach(() => vi.unstubAllGlobals());

describe("the example league (public demo)", () => {
  it("opens signed in, as the league's commissioner but not a site admin", async () => {
    const api = new DemoApi({ visitor: true });
    expect(await api.getSession()).not.toBeNull();
    const me = await api.me();
    expect(me.isCommissioner).toBe(true);
    expect(me.isSiteAdmin).toBe(false);
    expect(await api.myLeagues()).toHaveLength(1);
  });

  it("goes back to the real site when the visitor leaves, rather than to a sign-in page", async () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign } });
    const api = new DemoApi({ visitor: true });
    await api.signOut();
    expect(assign).toHaveBeenCalledWith("../");
    expect(await api.getSession()).not.toBeNull();
  });

  it("never touches the network: no odds pulls, no email, no database", async () => {
    const fetch = vi.fn(() => Promise.reject(new Error("the demo called the network")));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("XMLHttpRequest", vi.fn(() => { throw new Error("the demo called the network"); }));
    const api = new DemoApi({ visitor: true });
    const [entry] = await api.myEntries();
    const games = await api.games(5);
    const open = games.find((g) => g.status === "scheduled" && g.lines.length)!;
    const line = open.lines.find((l) => l.market === "spread" && l.side === "home")!;
    await Promise.all([
      api.league(), api.standings(), api.slips({}), api.hiddenActivity(), api.leagueNotes(), api.ruleVersions(),
      api.weeks(), api.entrants(), api.auditLog(), api.adminUsers(), api.adminRecentProblems(), api.adminPropHolds(),
    ]);
    const placed = await api.placeSlip({
      clientRef: "demo-test", entryId: entry!.entryId, type: "straight", teaserPoints: null, stakeCents: 10_000,
      legs: [{ gameId: open.id, market: "spread", side: "home", point: line.point, price: line.price }],
    });
    expect(placed.ok).toBe(true);
    expect(await api.adminEmailLeague("Week 5", "Get your bets in.", false)).toEqual({ sent: expect.any(Number) });
    await api.adminRunJob("pull-scores");
    expect(fetch).not.toHaveBeenCalled();
  });
});
