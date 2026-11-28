// STUB from the scaffold. Worker F1 replaces the body; keep the exported names and shapes.
import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { TODAY_PIECES } from "./types";
import type { AppFlowState, Piece, Switch } from "./types";

const fallback: AppFlowState = {
  ready: true, reviewerId: "", flow: null, pieces: TODAY_PIECES, exposed: false, preview: false,
};

const AppFlowContext = createContext<AppFlowState>(fallback);

export function AppFlowProvider({ children }: { search: string; children: ReactNode }) {
  return <AppFlowContext.Provider value={fallback}>{children}</AppFlowContext.Provider>;
}

export function useAppFlow(): AppFlowState {
  return useContext(AppFlowContext);
}

export function usePiece(name: Switch): Piece {
  return useAppFlow().pieces[name];
}
