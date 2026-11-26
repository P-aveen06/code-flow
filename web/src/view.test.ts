import { describe, expect, it } from "vitest";
import { FLOW_VIEWS, readFlowView } from "./view";

describe("readFlowView", () => {
  it("defaults to the overlay", () => {
    expect(readFlowView("")).toBe("overlay");
    expect(readFlowView("?repo=shop-demo")).toBe("overlay");
  });

  it.each(FLOW_VIEWS)("reads %s", (view) => {
    expect(readFlowView(`?repo=shop-demo&view=${view}`)).toBe(view);
  });

  it("falls back for an unknown or empty view", () => {
    expect(readFlowView("?view=other")).toBe("overlay");
    expect(readFlowView("?view=")).toBe("overlay");
  });
});
