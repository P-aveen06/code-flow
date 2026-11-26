import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { useCodeFlowFlags } from "../flags";
import { useRequest } from "../useRequest";
import { Viewer } from "./Viewer";

vi.mock("../flags", async (importOriginal) => ({
  ...await importOriginal<typeof import("../flags")>(),
  useCodeFlowFlags: vi.fn(),
}));
vi.mock("../useRequest", () => ({ useRequest: vi.fn(() => ({ status: "loading" })) }));

describe("viewer previews", () => {
  function renderViewer(variantPreview: boolean) {
    vi.mocked(useCodeFlowFlags).mockReturnValue({
      reviewerId: "demo",
      viewOverride: "overlay",
      directionOverride: "vertical",
      variantPreview,
      ready: true,
      assignedView: null,
      flowView: "overlay",
      flagsmithMode: false,
      reviewEventClient: null,
      directionFlag: null,
    });
    vi.mocked(useRequest).mockReturnValueOnce({
      status: "ready",
      data: {
        name: "shop-demo",
        url: null,
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
    return renderToStaticMarkup(<Viewer id="shop-demo" search="?view=overlay&direction=vertical" />);
  }

  it("shows both labeled controls and override actions with variant_preview on", () => {
    const markup = renderViewer(true);
    for (const name of ["variant", "direction"]) {
      expect(markup).toContain(`>Preview ${name}<`);
      expect(markup).toContain(`>Back to my assigned ${name}<`);
    }
    expect(markup).toContain("Dev override: <code>view=overlay</code>");
    expect(markup).toContain("Dev override: <code>direction=vertical</code>");
  });

  it("hides both controls and override actions with variant_preview off", () => {
    const markup = renderViewer(false);
    expect(markup).toContain("Show neighbours");
    expect(markup).not.toMatch(/Preview variant|Preview direction|Dev override|Back to my assigned/);
  });

  it("shows the four section headings and review settings with flag checks off", () => {
    const markup = renderViewer(true);
    expect(markup).toContain('<h2 title="Update checkout">Update checkout</h2>');
    for (const heading of ["Commits", "Flow", "Source code", "Flagsmith"]) {
      expect(markup).toMatch(new RegExp(`<h2[^>]*>${heading}</h2>`));
    }
    expect(markup).toContain(">This review<");
    expect(markup).toContain("<dd>Overlay<small>Preview</small></dd>");
    expect(markup).toContain("<dd>Vertical<small>Preview</small></dd>");
    expect(markup).toContain("Flag checks are off (flagsmith_mode)");
  });
});
