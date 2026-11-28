// Where an inline sign-in panel goes on a landing. Today's card for "today", Flow B's panel for "b",
// nothing for "a" (its own page at /signin) or "c" (a modal at the app root).
import type { ReactNode } from "react";
import { usePiece } from "./AppFlowProvider";
import { SignInPanelB } from "./flows/b/SignIn";

export function SignInSlot({ today, placement }: { today: ReactNode; placement?: "hero" | "section" }) {
  const piece = usePiece("signin_layout");
  if (piece === "today") return <>{today}</>;
  if (piece === "b") return <SignInPanelB placement={placement ?? "section"} />;
  return null;
}
