import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { OverlayNode } from "../types";
import { SymbolCard } from "./FlowCanvas";

const symbol: OverlayNode = {
  id: "segments.views:create_segment", kind: "function", status: "changed", module: "segments.views",
  name: "create_segment", qualname: "create_segment", file: "api/segments/views.py", line: 48, end_line: 60,
  in_base: true, in_head: true, lines_added: 12, lines_removed: 3,
};

it("shows kind, name, source location and line counts for a changed symbol", () => {
  const card = renderToStaticMarkup(<SymbolCard symbol={symbol} selected />);
  expect(card).toContain('aria-label="create_segment, function, changed, 12 lines added, 3 removed, api/segments/views.py line 48"');
  expect(card).toContain('aria-pressed="true"');
  for (const label of ["fn", "create_segment", "+12", "−3", "…/segments/views.py", ":48"]) {
    expect(card).toContain(`>${label}<`);
  }
  expect(card).toContain('title="api/segments/views.py"');
});

it("shows the module name and omits line counts for context or unavailable source", () => {
  const module = renderToStaticMarkup(<SymbolCard symbol={{ ...symbol, kind: "module", status: "context" }} selected={false} />);
  expect(module).toContain(">segments.views<");
  expect(module).not.toContain("line-counts");

  const unreadable = renderToStaticMarkup(<SymbolCard symbol={{ ...symbol, lines_added: null, lines_removed: null }} selected={false} />);
  expect(unreadable).not.toContain("line-counts");
});
