import { describe, expect, it, vi } from "vitest";
import { readReviewerId } from "./flags";

describe("reviewer identity", () => {
  it("generates an ID once and reuses it from storage", () => {
    const items = new Map<string, string>();
    const getStorage = () => ({
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => { items.set(key, value); },
    });
    const createId = vi.fn(() => "generated");
    expect(readReviewerId("", getStorage, createId)).toBe("generated");
    expect(readReviewerId("?commit=abc", getStorage, createId)).toBe("generated");
    expect(createId).toHaveBeenCalledTimes(1);
  });

  it("uses the URL override without touching storage", () => {
    const getStorage = vi.fn();
    expect(readReviewerId("?reviewer=demo%201", getStorage)).toBe("demo 1");
    expect(getStorage).not.toHaveBeenCalled();
  });

  it("keeps a tab ID when storage is blocked or full", () => {
    const blocked = () => { throw new Error("blocked"); };
    const full = () => ({ getItem: () => null, setItem: blocked });
    const id = readReviewerId("", blocked);
    expect(id).toBeTruthy();
    expect(readReviewerId("", blocked)).toBe(id);
    expect(readReviewerId("", full)).toBe(id);
  });
});
