import { describe, expect, it } from "vitest";
import type { FlagFinding, FlagStatus, Guard, RepoFlags } from "../types";
import {
  flagConnectionText, flagStatusText, groupFlagFindings, guardActivity, highlightedPaths, liveFlagStates, toggleFlagSelection,
} from "./flagFindings";
import { edgeStyle, guardLabel } from "./styles";

function flag(name: string, status: FlagStatus): FlagFinding {
  return {
    name, status, enabled: status === "live" ? true : status === "off" ? false : null,
    in_flagsmith: status === "live" || status === "off" || status === "unused", value: null,
    stale: false, stale_reason: null, checks: [], guarded_edges: [], dead_calls: [],
  };
}

describe("Flagsmith findings", () => {
  it("sorts by status and then name, omitting empty groups", () => {
    const findings = [
      flag("c", "off"), flag("b", "live"), flag("a", "live"), flag("d", "unused"), flag("f", "unknown"), flag("e", "orphan"),
    ];
    expect(groupFlagFindings(findings).map(({ status, findings }) =>
      [flagStatusText[status], findings.map(({ name }) => name)],
    )).toEqual([
      ["Orphan", ["e"]], ["Live", ["a", "b"]], ["Off", ["c"]], ["Unused", ["d"]], ["Unknown", ["f"]],
    ]);
    expect(groupFlagFindings([])).toEqual([]);
  });

  const connection: RepoFlags["flagsmith"] = {
    connected: true, environment: "Production", fetched_at: "2026-11-26T09:30:00Z", error: null,
  };

  it("shows freshness while connected and the server's error when disconnected", () => {
    const now = Date.parse("2026-11-26T09:30:03Z");
    expect(flagConnectionText(connection, now)).toBe("Live from Flagsmith · Production · updated 3 s ago");
    expect(flagConnectionText({ ...connection, connected: false, error: "Flagsmith timed out" }, now))
      .toBe("Flagsmith timed out");
  });

  it("uses only in-scope flags with known state and a live connection", () => {
    const data = { repo: "shop", sha: "abc", flagsmith: connection, flags: [flag("a", "off"), flag("b", "orphan")] };
    expect(liveFlagStates(data)).toEqual(new Map([["a", false]]));
    expect(liveFlagStates({ ...data, flagsmith: { ...connection, connected: false } })).toEqual(new Map());
  });
});

describe("guarded calls", () => {
  it.each([[true, "on", "live"], [true, "off", "off"], [false, "off", "live"], [false, "on", "off"]] as const)(
    "marks a %s flag's %s branch as %s",
    (enabled, when, expected) => {
      const guard: Guard = { flag: "checkout", when };
      const activity = guardActivity(guard, new Map([["checkout", enabled]]));
      expect(activity).toBe(expected);
      expect(guardLabel(guard, activity)).toBe(`checkout: ${when} · ${expected.toUpperCase()}`);
      expect(edgeStyle("removed", activity)).toMatchObject(expected === "live"
        ? { stroke: "var(--color-success)", strokeWidth: 3.5 }
        : { stroke: "var(--color-text-subtle)", strokeDasharray: "6 4" });
    },
  );

  it("keeps diff styling for an unknown guard or while mode is off", () => {
    const guard: Guard = { flag: "checkout", when: "on" };
    const activity = guardActivity(guard, new Map());
    expect(activity).toBeUndefined();
    expect(guardLabel(guard, activity)).toBe("checkout: on");
    expect(edgeStyle("removed", activity)).toEqual(edgeStyle("removed"));
  });

  it("highlights checking functions, guarded edges, and their endpoints", () => {
    const finding = {
      ...flag("checkout", "off"),
      checks: [{ file: "shop.py", line: 11, function: "checker", call: "has_feature" }],
    };
    const nodes = [{ id: "checker", parentId: "module" }, { id: "source" }, { id: "target" }, { id: "other" }];
    const edges = [
      { id: "guarded", source: "source", target: "target", data: { guard: { flag: "checkout", when: "on" } as const } },
      { id: "unrelated", source: "checker", target: "other", data: { guard: null } },
    ];
    expect(highlightedPaths(nodes, edges, finding)).toEqual({
      nodeIds: new Set(["checker", "source", "target", "module"]), edgeIds: new Set(["guarded"]),
    });
    expect(highlightedPaths(nodes, edges, flag("missing", "unused"))).toBeNull();
    expect(toggleFlagSelection("checkout", "checkout")).toBeUndefined();
    expect(toggleFlagSelection("checkout", "another")).toBe("another");
    expect(highlightedPaths(nodes, edges, undefined)).toBeNull();
  });
});
