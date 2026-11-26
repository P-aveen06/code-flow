import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { Timeline } from "./Timeline";

it("shows the commit author's name and keeps the full name in a tooltip", () => {
  const author = "Ada Lovelace with a very long display name";
  const markup = renderToStaticMarkup(<Timeline commits={[{
    sha: "a9b66f56789", parents: [], author, date: "2026-11-20T10:00:00Z", message: "Add checkout",
    summary: "Adds checkout",
    stats: { nodes_added: 1, nodes_removed: 0, nodes_changed: 0, edges_added: 0, edges_removed: 0 },
  }]} selectedSha="a9b66f56789" onSelect={vi.fn()} />);

  expect(markup).toContain(`<span class="timeline__author" title="${author}">${author}</span>`);
  expect(markup).toMatch(/a9b66f5<.*Ada Lovelace.*>20 Nov</);
});
