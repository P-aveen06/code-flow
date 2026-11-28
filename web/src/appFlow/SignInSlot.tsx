// Where an inline sign-in panel goes on a landing. Today's card for "today", Flow B's panel for "b".
// Flow A signs in on its own page (/signin) and C in a modal at the app root, so for "a" and "c" the
// slot shows `elsewhere`: nothing on a flow landing (its own button calls useSignIn().start()), and
// a small card with that button on today's landing, which has no such button.
import type { ReactNode } from "react";
import { usePiece } from "./AppFlowProvider";
import { SignInPanelB } from "./flows/b/SignIn";

export function SignInSlot({ today, placement, elsewhere = null }: {
  today: ReactNode;
  placement?: "hero" | "section";
  elsewhere?: ReactNode;
}) {
  const piece = usePiece("signin_layout");
  if (piece === "today") return <>{today}</>;
  if (piece === "b") return <SignInPanelB placement={placement ?? "section"} />;
  return <>{elsewhere}</>;
}
