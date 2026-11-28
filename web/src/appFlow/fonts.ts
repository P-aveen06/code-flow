import type { Flow, Piece } from "./types";

// The Google Fonts families each flow is designed with (docs/APP_FLOW_BUILD.md, "Mapping notes").
const GOOGLE_FONT_FAMILIES: Record<Flow, string> = {
  a: "family=Plus+Jakarta+Sans:wght@400;600;700&family=JetBrains+Mono:wght@400;600",
  b: "family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500",
  c: "family=Geist:wght@300;400;500&family=Geist+Mono:wght@400;500",
};

/**
 * Adds one stylesheet link for a flow's fonts. "today" loads nothing, as before, and each
 * flow's link is inserted once however many times this is called.
 */
export function loadFonts(family: Piece): void {
  if (family === "today") return;
  const id = `cf-fonts-${family}`;
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?${GOOGLE_FONT_FAMILIES[family]}&display=swap`;
  document.head.append(link);
}
