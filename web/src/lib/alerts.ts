// What's waiting on a site admin: player props on a player missing from a box score,
// which can't be graded until an admin says whether he played. The Admin menu shows
// their count and the Admin page lists them under Alerts.
import { useEffect } from "react";
import { useApi } from "./api.ts";
import { useLoad, type Loaded } from "./hooks.ts";
import type { PropHold } from "./types.ts";

const CHANGED = "blh:alerts-changed";

/** Tells every alert count on the page to look again (after an admin answers one). */
export function alertsChanged() {
  window.dispatchEvent(new Event(CHANGED));
}

/** The props waiting for a site admin, checked every minute. Empty for everyone else. */
export function usePropHolds(siteAdmin: boolean): Loaded<PropHold[]> {
  const api = useApi();
  const holds = useLoad(() => (siteAdmin ? api.adminPropHolds() : Promise.resolve([] as PropHold[])), [siteAdmin], 60_000);
  const { reload } = holds;
  useEffect(() => {
    window.addEventListener(CHANGED, reload);
    return () => window.removeEventListener(CHANGED, reload);
  }, [reload]);
  return holds;
}
