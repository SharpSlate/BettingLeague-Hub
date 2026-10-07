import { describe, expect, it } from "vitest";
import { buildIndex, nameKey, PROP_LAB_URL, propLabHref } from "./prop-lab.ts";

// The shape of sharpslatesports.com/data/nfl/prop-lab.json, cut down.
const DATA = {
  slate: {
    games: [
      { key: "BUF@LAR", away: "BUF", home: "LAR", away_name: "Buffalo Bills", home_name: "Los Angeles Rams" },
      { key: "TB@DAL", away: "TB", home: "DAL", away_name: "Tampa Bay Buccaneers", home_name: "Dallas Cowboys" },
      { key: "HOU@TEN", away: "HOU", home: "TEN", away_name: "Houston Texans", home_name: "Tennessee Titans" },
    ],
  },
  players: [
    { id: "00-0034857", name: "Josh Allen", team: "BUF", game: "BUF@LAR" },
    { id: "00-0036355", name: "Puka Nacua", team: "LAR", game: "BUF@LAR" },
    { id: "00-0033293", name: "Aaron Jones Sr.", team: "LAR", game: "BUF@LAR" },
    { id: "00-0039163", name: "C.J. Stroud", team: "HOU", game: "HOU@TEN" },
    { id: "00-0035000", name: "Gabriel Davis", team: "TEN", game: "HOU@TEN" },
    { id: "00-0033077", name: "Dak Prescott", team: "DAL", game: "TB@DAL" },
    { id: "00-0031111", name: "Mike Williams", team: "TB", game: "TB@DAL" },
    { id: "00-0032222", name: "Mike Williams", team: "TEN", game: "HOU@TEN" },
    { id: "bad", name: "Not On The Slate", team: "KC", game: "KC@LV" },
    { name: "No Id", team: "BUF", game: "BUF@LAR" },
  ],
};

const lab = buildIndex(DATA);
const card = (g: string, t: string, p: string, m?: string) =>
  `${PROP_LAB_URL}#g=${encodeURIComponent(g)}&t=${t}&p=${p}${m ? `&m=${m}` : ""}`;

describe("nameKey", () => {
  it("agrees across the books' and the Prop Lab's spellings", () => {
    expect(nameKey("C.J. Stroud")).toBe(nameKey("CJ Stroud"));
    expect(nameKey("D. J. Moore")).toBe("dj moore");
    expect(nameKey("Aaron Jones Sr.")).toBe("aaron jones");
    expect(nameKey("Marvin Harrison Jr")).toBe("marvin harrison");
    expect(nameKey("Luther Burden III")).toBe("luther burden");
    expect(nameKey("Ja'Marr Chase")).toBe("jamarr chase");
    expect(nameKey("Amon-Ra St. Brown")).toBe("amon ra st brown");
    expect(nameKey("José Núñez")).toBe("jose nunez");
  });
});

describe("propLabHref", () => {
  it("opens the player's own card, on the prop's market", () => {
    expect(propLabHref(lab, "Josh Allen", "pass_yds", ["Buffalo Bills", "Los Angeles Rams"]))
      .toBe(card("BUF@LAR", "BUF", "00-0034857", "player_pass_yds"));
    expect(propLabHref(lab, "Puka Nacua", "rec_yds", ["Buffalo Bills", "Los Angeles Rams"]))
      .toBe(card("BUF@LAR", "LAR", "00-0036355", "player_reception_yds"));
    expect(propLabHref(lab, "Dak Prescott", "anytime_td", ["Tampa Bay Buccaneers", "Dallas Cowboys"]))
      .toBe(card("TB@DAL", "DAL", "00-0033077", "player_anytime_td"));
  });

  it("takes the teams' short names (the slip has those) in either order", () => {
    expect(propLabHref(lab, "Josh Allen", "pass_yds", ["Rams", "Bills"]))
      .toBe(card("BUF@LAR", "BUF", "00-0034857", "player_pass_yds"));
  });

  it("matches names spelled differently by the books", () => {
    expect(propLabHref(lab, "Aaron Jones", "rush_yds", ["Bills", "Rams"])).toBe(card("BUF@LAR", "LAR", "00-0033293", "player_rush_yds"));
    expect(propLabHref(lab, "CJ Stroud", "pass_yds", ["Texans", "Titans"])).toBe(card("HOU@TEN", "HOU", "00-0039163", "player_pass_yds"));
    // A different first name: the one player in the game with that initial and last name.
    expect(propLabHref(lab, "Gabe Davis", "receptions", ["Texans", "Titans"])).toBe(card("HOU@TEN", "TEN", "00-0035000", "player_receptions"));
  });

  it("tells two players with one name apart by the game", () => {
    expect(propLabHref(lab, "Mike Williams", "rec_yds", ["Buccaneers", "Cowboys"])).toBe(card("TB@DAL", "TB", "00-0031111", "player_reception_yds"));
    expect(propLabHref(lab, "Mike Williams", "rec_yds", ["Texans", "Titans"])).toBe(card("HOU@TEN", "TEN", "00-0032222", "player_reception_yds"));
    // Not on either game: no telling which, so the Prop Lab's front page.
    expect(propLabHref(lab, "Mike Williams", "rec_yds", ["Chiefs", "Raiders"])).toBe(PROP_LAB_URL);
  });

  it("finds a player listed once even when our game isn't on the Prop Lab's slate", () => {
    expect(propLabHref(lab, "Josh Allen", null, ["Chiefs", "Raiders"])).toBe(card("BUF@LAR", "BUF", "00-0034857"));
  });

  it("never sends a player to a namesake on another game of the slate", () => {
    // Josh Allen is on BUF@LAR; a Josh Allen prop on TB@DAL isn't him.
    expect(propLabHref(lab, "Josh Allen", "receptions", ["Buccaneers", "Cowboys"])).toBe(`${PROP_LAB_URL}#g=TB%40DAL`);
  });

  it("opens the game when the player isn't on the Prop Lab, else its front page", () => {
    expect(propLabHref(lab, "Someone New", "receptions", ["Bills", "Rams"])).toBe(`${PROP_LAB_URL}#g=BUF%40LAR`);
    expect(propLabHref(lab, "Someone New", "receptions", ["Chiefs", "Raiders"])).toBe(PROP_LAB_URL);
    expect(propLabHref(lab, "Not On The Slate", "receptions", ["Chiefs", "Raiders"])).toBe(PROP_LAB_URL);
  });

  it("opens the Prop Lab's front page before its player list has loaded", () => {
    expect(propLabHref(null, "Josh Allen", "pass_yds", ["Bills", "Rams"])).toBe(PROP_LAB_URL);
  });
});

describe("buildIndex", () => {
  it("survives a file in a shape it doesn't know", () => {
    for (const bad of [null, undefined, 3, "x", [], {}, { slate: {} }, { slate: { games: "x" }, players: {} }, { slate: { games: [null, 4] }, players: [null, 7, {}] }]) {
      const i = buildIndex(bad);
      expect(propLabHref(i, "Josh Allen", "pass_yds", ["Bills", "Rams"])).toBe(PROP_LAB_URL);
    }
  });
});
