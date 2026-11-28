// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { loadFonts } from "./fonts";

afterEach(() => {
  document.head.innerHTML = "";
});

describe("loadFonts", () => {
  it("loads nothing for today's UI", () => {
    loadFonts("today");
    expect(document.querySelectorAll("link")).toHaveLength(0);
  });

  it.each([
    ["a", "family=Plus+Jakarta+Sans:wght@400;600;700&family=JetBrains+Mono:wght@400;600"],
    ["b", "family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500"],
    ["c", "family=Geist:wght@300;400;500&family=Geist+Mono:wght@400;500"],
  ] as const)("adds one display=swap stylesheet for flow %s", (flow, families) => {
    loadFonts(flow);
    const link = document.querySelector<HTMLLinkElement>(`link#cf-fonts-${flow}`);
    expect(link?.rel).toBe("stylesheet");
    expect(link?.getAttribute("href")).toBe(`https://fonts.googleapis.com/css2?${families}&display=swap`);
  });

  it("inserts each flow's stylesheet only once", () => {
    loadFonts("a");
    loadFonts("a");
    loadFonts("b");
    expect(document.querySelectorAll("link#cf-fonts-a")).toHaveLength(1);
    expect(document.querySelectorAll("link")).toHaveLength(2);
  });
});
