import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { useCodeFlowFlags } from "../flags";
import type { RepoFlags } from "../types";
import { useRepoFlags } from "../useRepoFlags";
import { useRequest } from "../useRequest";
import { Viewer } from "./Viewer";

vi.mock("../flags", async (importOriginal) => ({
  ...await importOriginal<typeof import("../flags")>(),
  useCodeFlowFlags: vi.fn(),
}));
vi.mock("../useRequest", () => ({ useRequest: vi.fn(() => ({ status: "loading" })) }));
vi.mock("../useRepoFlags", () => ({ useRepoFlags: vi.fn() }));

const repoFlags: RepoFlags = {
  repo: "review-fixture",
  sha: "abc123",
  flagsmith: {
    connected: true, environment: "Production", fetched_at: "2026-11-26T10:00:00Z", error: null,
  },
  flags: [{
    name: "fast_checkout", status: "orphan", enabled: null, value: null, in_flagsmith: false,
    checks: [{ file: "checkout.py", line: 12, function: "checkout:submit", call: "has_feature" }],
    guarded_edges: [], stale: false, stale_reason: null, dead_calls: [],
  }],
};

describe("viewer", () => {
  function renderViewer({
    variantPreview = false, url = "https://github.com/example/review", liveFlagPanel = false, flagsmithMode = false,
  }: { variantPreview?: boolean; url?: string | null; liveFlagPanel?: boolean; flagsmithMode?: boolean } = {}) {
    vi.mocked(useCodeFlowFlags).mockReturnValue({
      reviewerId: "demo",
      viewOverride: "overlay",
      directionOverride: "vertical",
      variantPreview,
      ready: true,
      assignedView: null,
      flowView: "overlay",
      flagsmithMode,
      liveFlagPanel,
      reviewEventClient: null,
      directionFlag: null,
    });
    vi.mocked(useRepoFlags).mockClear().mockReturnValue(flagsmithMode
      ? { status: "ready", data: repoFlags }
      : { status: "loading" });
    vi.mocked(useRequest).mockReturnValueOnce({
      status: "ready",
      data: {
        name: "review-fixture",
        url,
        subdir: null,
        hasNodes: true,
        commits: [{
          sha: "abc123",
          message: "Update checkout",
          author: "Demo",
          date: "2026-11-26T10:00:00Z",
          stats: { nodes_added: 1, nodes_removed: 0, nodes_changed: 0, edges_added: 0, edges_removed: 0 },
        }],
      },
    });
    return renderToStaticMarkup(<Viewer id="review-fixture" search="?view=overlay&direction=vertical" />);
  }

  it("shows all labeled controls and override actions with variant_preview on", () => {
    const markup = renderViewer({ variantPreview: true });
    for (const name of ["variant", "direction"]) {
      expect(markup).toContain(`>Preview ${name}<`);
      expect(markup).toContain(`>Back to my assigned ${name}<`);
    }
    expect(markup).toContain("Dev override: <code>view=overlay</code>");
    expect(markup).toContain("Dev override: <code>direction=vertical</code>");
  });

  it("hides all controls and override actions with variant_preview off", () => {
    const markup = renderViewer();
    expect(markup).toContain("Show neighbours");
    expect(markup).not.toMatch(/Preview variant|Preview direction|Dev override|Back to my assigned/);
  });

  it("offers manual refresh for GitHub imports with previews on or off", () => {
    expect(renderViewer()).toContain(">Check for new commits<");
    expect(renderViewer({ variantPreview: true })).toContain(">Check for new commits<");
    expect(renderViewer({ url: null })).not.toContain(">Check for new commits<");
  });

  it("shows the four section headings and review settings", () => {
    const markup = renderViewer({ variantPreview: true });
    expect(markup).toContain('<h2 title="Update checkout">Update checkout</h2>');
    for (const heading of ["Commits", "Flow", "Source code", "Flagsmith"]) {
      expect(markup).toMatch(new RegExp(`<h2[^>]*>${heading}</h2>`));
    }
    expect(markup).toContain(">This review<");
    expect(markup).toContain("<dd>Overlay<small>Preview</small></dd>");
    expect(markup).toContain("<dd>Vertical<small>Preview</small></dd>");
  });

  it.each([false, true])("hides findings by default with flagsmith_mode set to %s", (flagsmithMode) => {
    const markup = renderViewer({ flagsmithMode });

    expect(useRepoFlags).toHaveBeenCalledWith("review-fixture", flagsmithMode ? "abc123" : undefined);
    expect(markup).toContain(">This review<");
    expect(markup).not.toMatch(/Flag checks are off|Live from Flagsmith|Orphan|fast_checkout|checkout\.py:12/);
  });

  it("shows the off message when the panel is enabled and flag checks are off", () => {
    const markup = renderViewer({ liveFlagPanel: true });

    expect(markup).toContain(">This review<");
    expect(markup).toContain("Flag checks are off (flagsmith_mode)");
    expect(markup).not.toContain("Live from Flagsmith");
  });

  it("shows the connection, findings, and check locations when both flags are on", () => {
    const markup = renderViewer({ liveFlagPanel: true, flagsmithMode: true });

    expect(markup).toContain(">This review<");
    expect(markup).toMatch(/Live from Flagsmith · Production · updated \d+ s ago/);
    expect(markup).toContain("<h3>Orphan</h3>");
    expect(markup).toContain("<code>fast_checkout</code>");
    expect(markup).toContain("<code>checkout.py:12</code>");
    expect(markup).not.toContain("Flag checks are off");
  });
});
