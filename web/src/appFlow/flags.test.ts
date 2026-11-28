import type { IFlagsmithFeature } from "@flagsmith/flagsmith";
import { describe, expect, it, vi } from "vitest";
import {
  applyPreview, experimentSwitches, NO_PREVIEW, PREVIEW_STORAGE_KEY, readPreview, recordExposure,
  resolveFlow, resolvePiece, resolvePieces,
} from "./flags";
import type { FlagsAnswer, PreviewStorage, UiFlags } from "./flags";
import { SWITCHES, TODAY_PIECES } from "./types";

// A Flagsmith feature as the SDK returns it. `inExperiment` adds an experiment field.
function flag(enabled: boolean, value: unknown, inExperiment?: boolean): IFlagsmithFeature {
  const experiment = inExperiment === undefined ? undefined : { id: 1, name: "Stacking round", inExperiment };
  return { enabled, value, experiment } as unknown as IFlagsmithFeature;
}

function memoryStorage(initial: Record<string, string> = {}): PreviewStorage & { items: Map<string, string> } {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => { items.set(key, value); },
    removeItem: (key) => { items.delete(key); },
  };
}

describe("resolveFlow", () => {
  it.each(["a", "b", "c"])("uses an enabled app_flow value %s", (value) => {
    expect(resolveFlow(flag(true, value), undefined)).toBe(value);
  });

  it("is off when the app_flow flag is disabled, even with a flow value", () => {
    expect(resolveFlow(flag(false, "b"), "a")).toBeNull();
  });

  it.each([null, "flow", "A", "", 1, true])("is off when the value is %j", (value) => {
    expect(resolveFlow(flag(true, value), undefined)).toBeNull();
  });

  it("is off when Flagsmith answered without the flag, and ignores the fallback", () => {
    expect(resolveFlow(null, "a")).toBeNull();
  });

  it("uses the fallback when Flagsmith did not answer", () => {
    expect(resolveFlow(undefined, "c")).toBe("c");
    expect(resolveFlow(undefined, "x")).toBeNull();
    expect(resolveFlow(undefined, undefined)).toBeNull();
  });
});

describe("resolvePiece", () => {
  it("is today everywhere when app_flow is off", () => {
    expect(resolvePiece(undefined, null)).toBe("today");
    expect(resolvePiece(flag(true, "a"), null)).toBe("today");
    expect(resolvePiece(flag(true, "flow"), null)).toBe("today");
  });

  it("follows the flow when the ui flag is missing", () => {
    expect(resolvePiece(undefined, "b")).toBe("b");
  });

  it("is today when the ui flag is disabled", () => {
    expect(resolvePiece(flag(false, "a"), "b")).toBe("today");
    expect(resolvePiece(flag(false, "flow"), "b")).toBe("today");
  });

  it.each(["a", "b", "c"] as const)("is the pinned or split value %s", (value) => {
    expect(resolvePiece(flag(true, value), "a")).toBe(value);
  });

  it.each(["flow", "other", "", null, 3])("follows the flow for the value %j", (value) => {
    expect(resolvePiece(flag(true, value), "c")).toBe("c");
  });
});

describe("resolvePieces", () => {
  it("gives every switch a piece", () => {
    const pieces = resolvePieces({}, "b");
    expect(Object.keys(pieces).sort()).toEqual([...SWITCHES].sort());
    expect(Object.values(pieces).every((piece) => piece === "b")).toBe(true);
  });

  it("is all today when app_flow is off", () => {
    expect(resolvePieces({ colours: flag(true, "a") }, null)).toEqual(TODAY_PIECES);
  });

  it("applies each switch's own flag", () => {
    const pieces = resolvePieces({ colours: flag(false, "a"), buttons: flag(true, "a") }, "b");
    expect(pieces).toMatchObject({ colours: "today", buttons: "a", font_family: "b" });
  });
});

describe("readPreview", () => {
  it("reads nothing without overrides, and keeps storage untouched", () => {
    const storage = memoryStorage();
    expect(readPreview("?reviewer=demo", () => storage)).toEqual(NO_PREVIEW);
    expect(storage.items.size).toBe(0);
  });

  it("reads the app_flow and ui_<switch> overrides from the URL", () => {
    const preview = readPreview("?app_flow=b&ui_colours=off&ui_buttons=flow&ui_font_family=c", () => memoryStorage());
    expect(preview).toEqual({
      appFlow: "b", pieces: { colours: "off", buttons: "flow", font_family: "c" },
    });
  });

  it("ignores values that are not overrides", () => {
    const preview = readPreview("?app_flow=zzz&ui_colours=today&ui_unknown=a", () => memoryStorage());
    expect(preview).toEqual(NO_PREVIEW);
  });

  it("saves overrides so they survive navigation", () => {
    const storage = memoryStorage();
    readPreview("?app_flow=a&ui_colours=b", () => storage);
    expect(JSON.parse(storage.items.get(PREVIEW_STORAGE_KEY) ?? "null")).toEqual({
      appFlow: "a", pieces: { colours: "b" },
    });

    expect(readPreview("", () => storage)).toEqual({ appFlow: "a", pieces: { colours: "b" } });
  });

  it("merges new URL overrides over the saved ones", () => {
    const storage = memoryStorage();
    readPreview("?app_flow=a", () => storage);
    expect(readPreview("?ui_colours=c", () => storage)).toEqual({ appFlow: "a", pieces: { colours: "c" } });
    expect(readPreview("?app_flow=off", () => storage)).toEqual({ appFlow: "off", pieces: { colours: "c" } });
  });

  it("clears the saved overrides on app_flow=reset", () => {
    const storage = memoryStorage();
    readPreview("?app_flow=a&ui_colours=b", () => storage);
    expect(readPreview("?app_flow=reset", () => storage)).toEqual(NO_PREVIEW);
    expect(storage.items.has(PREVIEW_STORAGE_KEY)).toBe(false);
    expect(readPreview("", () => storage)).toEqual(NO_PREVIEW);
  });

  it("applies URL overrides that arrive with a reset", () => {
    const storage = memoryStorage();
    readPreview("?app_flow=a", () => storage);
    expect(readPreview("?app_flow=reset&ui_buttons=c", () => storage)).toEqual({ pieces: { buttons: "c" } });
  });

  it("ignores saved overrides that are malformed", () => {
    const storage = memoryStorage({ [PREVIEW_STORAGE_KEY]: "{not json" });
    expect(readPreview("", () => storage)).toEqual(NO_PREVIEW);

    storage.items.set(PREVIEW_STORAGE_KEY, JSON.stringify({ appFlow: "zzz", pieces: { colours: "x", nope: "a" } }));
    expect(readPreview("", () => storage)).toEqual(NO_PREVIEW);
  });

  it("still applies URL overrides when storage is blocked", () => {
    const blocked = () => { throw new Error("blocked"); };
    expect(readPreview("?app_flow=c", blocked)).toEqual({ appFlow: "c", pieces: {} });
    expect(readPreview("", blocked)).toEqual(NO_PREVIEW);
  });
});

describe("applyPreview", () => {
  const answer: FlagsAnswer = {
    flow: "b",
    uiFlags: { colours: flag(false, "a"), buttons: flag(true, "c") } as UiFlags,
  };

  it("is Flagsmith's answer when there is no preview", () => {
    const decision = applyPreview(answer, NO_PREVIEW);
    expect(decision).toEqual({ flow: "b", pieces: resolvePieces(answer.uiFlags, "b"), preview: false });
  });

  it("replaces the flow and lets the new flow decide the other pieces", () => {
    const decision = applyPreview(answer, { appFlow: "a", pieces: {} });
    expect(decision.flow).toBe("a");
    expect(decision.pieces).toMatchObject({ colours: "today", buttons: "c", font_family: "a" });
    expect(decision.preview).toBe(true);
  });

  it("turns the flow off, which makes every piece today", () => {
    const decision = applyPreview(answer, { appFlow: "off", pieces: {} });
    expect(decision.flow).toBeNull();
    expect(decision.pieces).toEqual(TODAY_PIECES);
    expect(decision.preview).toBe(true);
  });

  it("lets a piece override beat the flow being off and an ablated flag", () => {
    const decision = applyPreview(answer, { appFlow: "off", pieces: { colours: "a", font_family: "off" } });
    expect(decision.pieces).toMatchObject({ colours: "a", font_family: "today", buttons: "today" });
  });

  it("turns a piece off, or follows the flow", () => {
    expect(applyPreview(answer, { pieces: { buttons: "off" } }).pieces.buttons).toBe("today");
    expect(applyPreview(answer, { pieces: { colours: "flow" } }).pieces.colours).toBe("b");
    expect(applyPreview(answer, { appFlow: "off", pieces: { colours: "flow" } }).pieces.colours).toBe("today");
  });

  it("pins a piece to a flow even when its ui flag is disabled", () => {
    expect(applyPreview(answer, { pieces: { colours: "c" } }).pieces.colours).toBe("c");
  });
});

describe("recordExposure", () => {
  it("asks the SDK once per visitor and flag, and remembers the answer", () => {
    const exposures = new Map<string, boolean>();
    const read = vi.fn(() => flag(true, "b", true));

    expect(recordExposure("demo-1", "app_flow", exposures, read)).toBe(true);
    expect(recordExposure("demo-1", "app_flow", exposures, read)).toBe(true);
    expect(read).toHaveBeenCalledOnce();

    expect(recordExposure("demo-2", "app_flow", exposures, read)).toBe(true);
    expect(recordExposure("demo-1", "ui_colours", exposures, read)).toBe(true);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("does not count a visitor outside the experiment, and does not ask again", () => {
    const exposures = new Map<string, boolean>();
    const read = vi.fn(() => flag(true, "b", false));

    expect(recordExposure("demo-1", "app_flow", exposures, read)).toBe(false);
    expect(recordExposure("demo-1", "app_flow", exposures, read)).toBe(false);
    expect(read).toHaveBeenCalledOnce();
  });

  it.each([
    ["no flag", () => null],
    ["a disabled flag", () => flag(false, "b", true)],
    ["a flag without an experiment", () => flag(true, "b")],
  ])("does not count %s", (_, read) => {
    expect(recordExposure("demo", "app_flow", new Map(), read)).toBe(false);
  });
});

describe("experimentSwitches", () => {
  it("lists the live ui flags that are part of an experiment", () => {
    const uiFlags: UiFlags = {
      colours: flag(true, "a", true),
      buttons: flag(false, "a", true),
      font_family: flag(true, "b"),
    };
    expect(experimentSwitches(uiFlags)).toEqual(["colours"]);
    expect(experimentSwitches({})).toEqual([]);
  });
});
