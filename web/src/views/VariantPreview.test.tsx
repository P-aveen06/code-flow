import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DirectionPreview, VariantPreview } from "./VariantPreview";

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

describe("direction preview labels", () => {
  const props = { ready: true, onChange: vi.fn() };

  it("labels its separate radio group and shows the assigned direction", () => {
    const markup = renderToStaticMarkup(
      <DirectionPreview direction="vertical" directionOverride={null} assignedDirection="vertical" longFlow {...props} />,
    );
    expect(markup).toContain('aria-labelledby="direction-preview-label" aria-describedby="direction-preview-status"');
    expect(markup).toContain(">Preview direction<");
    expect(markup).toContain(">Horizontal<");
    expect(markup).toContain('aria-checked="true" tabindex="0">Vertical<');
    expect(markup).toContain(">Assigned by Flagsmith: Vertical<");
  });

  it("explains short flows and allows an uncounted vertical preview", () => {
    const short = renderToStaticMarkup(
      <DirectionPreview direction="horizontal" directionOverride={null} assignedDirection={null} longFlow={false} {...props} />,
    );
    const preview = renderToStaticMarkup(
      <DirectionPreview direction="vertical" directionOverride="vertical" assignedDirection={null} longFlow={false} {...props} />,
    );
    expect(short).toContain(">Short flow: horizontal (not in the experiment)<");
    expect(preview).toContain('aria-checked="true" tabindex="0">Vertical<');
    expect(preview).toContain("Dev override: <code>direction=vertical</code> (not counted in the experiment)");
    expect(preview).toContain(">Back to my assigned direction<");
  });
});
