import { expect, it } from "vitest";
import {
  clampSourcePercent, defaultSourcePercent, parseSourcePercent, sourcePercentBounds, sourcePercentForKey,
} from "./flowSourceSplit";

it("keeps at least 280px for Flow and 120px below the Source code heading", () => {
  const paneHeight = 560;
  const bounds = sourcePercentBounds(paneHeight, 48);

  expect(clampSourcePercent(5, bounds) / 100 * paneHeight).toBeCloseTo(168);
  expect((1 - clampSourcePercent(95, bounds) / 100) * paneHeight).toBeCloseTo(280);
  expect(clampSourcePercent(40, bounds)).toBe(40);
});

it("clamps the default on short layouts to leave space for source content", () => {
  const bounds = sourcePercentBounds(500, 40);
  expect(clampSourcePercent(defaultSourcePercent, bounds)).toBe(32);
  expect(sourcePercentBounds(400, 40)).toEqual({ min: 40, max: 40 });
});

it("restores stored percentages and uses the default for missing or invalid values", () => {
  expect(parseSourcePercent("42.5")).toBe(42.5);
  for (const value of [null, "", "  ", "30%", "NaN", "Infinity", "-4", "0", "100", "150"]) {
    expect(parseSourcePercent(value)).toBe(30);
  }
});

it("moves the divider in two-point steps and resets it with Home", () => {
  expect(sourcePercentForKey("ArrowUp", 40)).toBe(42);
  expect(sourcePercentForKey("ArrowDown", 40)).toBe(38);
  expect(sourcePercentForKey("Home", 40)).toBe(30);
  expect(sourcePercentForKey("ArrowRight", 40)).toBeUndefined();
});
