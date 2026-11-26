import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { VariantPreview } from "./VariantPreview";

describe("variant preview labels", () => {
  it("labels the control and highlights the Flagsmith assignment", () => {
    const markup = renderToStaticMarkup(
      <VariantPreview view="overlay" viewOverride={null} assignedView="overlay" ready onChange={vi.fn()} />,
    );
    expect(markup).toContain(">Preview variant<");
    expect(markup).toContain(">Side by side<");
    expect(markup).toContain(">Overlay + summary<");
    expect(markup).toContain('aria-checked="true" tabindex="0">Overlay<');
    expect(markup).toContain(">Assigned by Flagsmith: Overlay<");
    expect(markup).not.toContain("Back to my assigned variant");
  });

  it("shows the override badge and return button in preview mode", () => {
    const markup = renderToStaticMarkup(
      <VariantPreview view="overlay_summary" viewOverride="overlay_summary" assignedView={null} ready onChange={vi.fn()} />,
    );
    expect(markup).toContain('aria-checked="true" tabindex="0">Overlay + summary<');
    expect(markup).toContain("Dev override: <code>view=overlay_summary</code> (not counted in the experiment)");
    expect(markup).toContain(">Back to my assigned variant<");
    expect(markup).not.toContain("Assigned by Flagsmith:");
  });

  it("labels the side by side fallback when Flagsmith is unavailable", () => {
    const markup = renderToStaticMarkup(
      <VariantPreview view="side_by_side" viewOverride={null} assignedView={null} ready onChange={vi.fn()} />,
    );
    expect(markup).toContain(">Flagsmith unavailable — showing side by side<");
    expect(markup).not.toContain("Assigned by Flagsmith:");
  });
});
