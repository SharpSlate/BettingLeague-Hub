import { createContext, useContext } from "react";
import type { Me } from "./types.ts";

export const MeContext = createContext<Me | null>(null);

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error("MeContext missing");
  return me;
}
