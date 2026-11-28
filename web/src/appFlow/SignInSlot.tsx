// STUB from the scaffold. Worker F1 replaces the body; keep the exported name and props.
// Landing layouts put this where an inline sign-in panel belongs. It renders `today`
// (today's sign-in card) for the "today" sign-in piece, Flow B's inline panel for "b",
// and nothing for "a" (own page at /signin) or "c" (modal at the app root).
import type { ReactNode } from "react";

export function SignInSlot({ today }: { today: ReactNode; placement?: "hero" | "section" }) {
  return <>{today}</>;
}
