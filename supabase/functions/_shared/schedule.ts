// When the scheduled jobs should do work. Cron fires in UTC; these checks are in
// the league's time zone so daylight saving time is handled.

export function localMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? NaN);
  return get("hour") * 60 + get("minute");
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Is `at` inside the daily pull window, both ends included? The window may wrap past
 * midnight: 08:00-01:00 covers 8am through 1am the next morning.
 */
export function inPullWindow(at: Date, start: string, end: string, timeZone: string): boolean {
  const m = localMinutes(at, timeZone);
  const s = toMinutes(start);
  const e = toMinutes(end);
  return s <= e ? m >= s && m <= e : m >= s || m <= e;
}

/** Lines are due for a refresh before a bet when the last good pull is older than this. */
export function isStale(lastPull: Date | null, now: Date, maxAgeSeconds: number): boolean {
  return lastPull === null || now.getTime() - lastPull.getTime() > maxAgeSeconds * 1000;
}
