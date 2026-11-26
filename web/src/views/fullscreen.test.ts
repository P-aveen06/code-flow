import { describe, expect, it, vi } from "vitest";
import { enterDiagramFullscreen, isFullscreenShortcut } from "./fullscreen";

const key = {
  key: "f", defaultPrevented: false, repeat: false, isComposing: false,
  altKey: false, ctrlKey: false, metaKey: false,
};

describe("the fullscreen shortcut", () => {
  it("accepts F in the viewer and ignores it while editing", () => {
    expect(isFullscreenShortcut(key, false)).toBe(true);
    expect(isFullscreenShortcut({ ...key, key: "F" }, false)).toBe(true);
    expect(isFullscreenShortcut(key, true)).toBe(false);
    expect(isFullscreenShortcut({ ...key, key: "Escape" }, false)).toBe(false);
  });

  it.each(["ctrlKey", "metaKey", "altKey", "repeat", "defaultPrevented", "isComposing"] as const)(
    "ignores F when %s is set",
    (property) => expect(isFullscreenShortcut({ ...key, [property]: true }, false)).toBe(false),
  );
});

describe("enterDiagramFullscreen", () => {
  it("maximizes the diagram when native fullscreen is unavailable", async () => {
    await expect(enterDiagramFullscreen()).resolves.toBe("maximized");
  });

  it("maximizes the diagram when native fullscreen is denied", async () => {
    const request = () => Promise.reject(new Error("Permissions check failed"));
    await expect(enterDiagramFullscreen(request)).resolves.toBe("maximized");
  });

  it("keeps native fullscreen when the request succeeds", async () => {
    await expect(enterDiagramFullscreen(() => Promise.resolve())).resolves.toBe("native");
  });

  it("maximizes the diagram after 800 ms if the native request has not settled", async () => {
    vi.useFakeTimers();
    try {
      const onEntered = vi.fn();
      void enterDiagramFullscreen(() => new Promise<void>(() => {})).then(onEntered);

      await vi.advanceTimersByTimeAsync(799);
      expect(onEntered).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(onEntered).toHaveBeenCalledWith("maximized");
    } finally {
      vi.useRealTimers();
    }
  });
});
