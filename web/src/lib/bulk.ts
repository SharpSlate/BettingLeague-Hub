// Parsers for the Admin page's paste boxes: many Splash standings rows, or many
// entry-to-member pairings, at once. Columns are split on "|" or tabs (not commas,
// since Splash writes 33,213.70).
import { toCents } from "./format.ts";

export interface StandingsLine {
  name: string;
  bankCents: number;
  netCents: number;
  wins: number;
  losses: number;
  pushes: number;
  riskCents: number;
  returnCents: number;
  winningsCents: number;
}

export interface PairingLine {
  entryName: string;
  email: string;
  displayName: string;
}

export interface Parsed<T> {
  rows: T[];
  errors: string[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function lines(text: string): { n: number; cols: string[] }[] {
  return text.split(/\r?\n/)
    .map((line, i) => ({ n: i + 1, line: line.trim() }))
    .filter(({ line }) => line !== "" && !line.startsWith("#"))
    .map(({ n, line }) => ({ n, cols: line.split(/\s*\|\s*|\t+/).map((c) => c.trim()) }));
}

function amount(text: string, allowNegative: boolean): number | null {
  const t = text.trim().replace(/^[−–]/, "-");
  const neg = t.startsWith("-");
  if (neg && !allowNegative) return null;
  const c = toCents(t.replace(/^[-+]/, ""));
  return c === null ? null : neg ? -c : c;
}

/** "Name | bank | net | W-L or W-L-P | risk | return [| total winnings]", one entry per line. */
export function parseStandings(text: string): Parsed<StandingsLine> {
  const rows: StandingsLine[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const { n, cols } of lines(text)) {
    const [name = "", bank = "", net = "", record = "", risk = "", ret = "", win = ""] = cols;
    if (cols.length < 6) { errors.push(`Line ${n}: needs name | bank | net | record | risk | return.`); continue; }
    if (!name || name.length > 40) { errors.push(`Line ${n}: the entry name must be 1 to 40 characters.`); continue; }
    if (seen.has(name.toLowerCase())) { errors.push(`Line ${n}: ${name} is listed twice.`); continue; }
    const rec = record.match(/^(\d+)\s*-\s*(\d+)(?:\s*-\s*(\d+))?$/);
    const nums = [amount(bank, false), amount(net, true), amount(risk, false), amount(ret, false), win ? amount(win, false) : 0];
    if (!rec) { errors.push(`Line ${n} (${name}): the record should look like 5-2 or 5-2-1.`); continue; }
    if (nums.some((x) => x === null)) { errors.push(`Line ${n} (${name}): an amount isn't a number of units.`); continue; }
    const [bankCents, netCents, riskCents, returnCents, winningsCents] = nums as number[];
    seen.add(name.toLowerCase());
    rows.push({
      name, bankCents: bankCents!, netCents: netCents!, wins: Number(rec[1]), losses: Number(rec[2]), pushes: Number(rec[3] ?? 0),
      riskCents: riskCents!, returnCents: returnCents!, winningsCents: winningsCents!,
    });
  }
  return { rows, errors };
}

/** "Entry name | email | display name", one pairing per line. The display name is only needed for someone new. */
export function parsePairings(text: string): Parsed<PairingLine> {
  const rows: PairingLine[] = [];
  const errors: string[] = [];
  for (const { n, cols } of lines(text)) {
    const [entryName = "", email = "", displayName = ""] = cols;
    if (!entryName || !email) { errors.push(`Line ${n}: needs entry name | email | display name.`); continue; }
    if (!EMAIL.test(email)) { errors.push(`Line ${n} (${entryName}): "${email}" isn't an email address.`); continue; }
    rows.push({ entryName, email: email.toLowerCase(), displayName: displayName.slice(0, 40) });
  }
  return { rows, errors };
}
