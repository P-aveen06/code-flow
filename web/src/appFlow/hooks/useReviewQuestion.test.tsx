// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordDiffViewed } from "../../events";
import type { ReviewContext, ReviewEvent } from "../../events";
import { useReviewQuestion } from "./useReviewQuestion";

vi.mock("../../events", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../events")>(),
  recordDiffViewed: vi.fn(),
}));

const context: ReviewContext = {
  view: "overlay", reviewerId: "reviewer-1", devOverride: false, repo: "demo", head: "abc123", base: "def456",
};

let root: Root;
let container: HTMLDivElement;
let question: ReturnType<typeof useReviewQuestion>;

function Probe({ current, onReview }: { current: ReviewContext | null; onReview: (payload: ReviewEvent) => void }) {
  question = useReviewQuestion(current, onReview);
  return (
    <div data-can-review={String(question.canReview)} data-answered={String(question.answered)}>
      <input aria-label="notes" />
    </div>
  );
}

function state() {
  const probe = container.firstElementChild;
  return { canReview: probe?.getAttribute("data-can-review"), answered: probe?.getAttribute("data-answered") };
}

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window) {
  return act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(performance, "now").mockReturnValue(1_000);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("review question timing", () => {
  it("opens with the diagram and records the view once, however often the context changes", async () => {
    const onReview = vi.fn();
    await act(async () => root.render(<Probe current={context} onReview={onReview} />));
    expect(state()).toEqual({ canReview: "true", answered: "false" });
    expect(recordDiffViewed).toHaveBeenCalledTimes(1);
    expect(recordDiffViewed).toHaveBeenCalledWith(context);

    await act(async () => root.render(<Probe current={{ ...context }} onReview={onReview} />));
    expect(recordDiffViewed).toHaveBeenCalledTimes(1);
  });

  it("measures the time from the diagram to the first answer and locks the question after it", async () => {
    const onReview = vi.fn();
    await act(async () => root.render(<Probe current={context} onReview={onReview} />));

    vi.mocked(performance.now).mockReturnValue(3_500);
    await press("u");
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(onReview).toHaveBeenCalledWith({ ...context, event: "diff_understood", ms: 2_500 });
    expect(state()).toEqual({ canReview: "false", answered: "true" });

    await press("c");
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it("records one answer when two arrive before the screen updates", async () => {
    const onReview = vi.fn();
    await act(async () => root.render(<Probe current={context} onReview={onReview} />));

    await act(async () => {
      question.submit("diff_understood");
      question.submit("diff_confusing");
    });
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ event: "diff_understood" }));
  });
});

describe("review question keys", () => {
  it("answers C as confusing and ignores keys that belong to other controls", async () => {
    const onReview = vi.fn();
    await act(async () => root.render(<Probe current={context} onReview={onReview} />));

    await press("x");
    await press("u", { ctrlKey: true });
    await press("u", { metaKey: true });
    await press("u", { altKey: true });
    await press("u", { repeat: true });
    await press("u", {}, container.querySelector("input")!);
    expect(onReview).not.toHaveBeenCalled();

    await press("C");
    expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ event: "diff_confusing" }));
  });

  it("does not take an answer before the diagram is shown", async () => {
    const onReview = vi.fn();
    await act(async () => root.render(<Probe current={null} onReview={onReview} />));

    expect(state()).toEqual({ canReview: "false", answered: "false" });
    await press("u");
    expect(onReview).not.toHaveBeenCalled();
    expect(recordDiffViewed).not.toHaveBeenCalled();
  });
});
