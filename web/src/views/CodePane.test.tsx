import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { CodeSnippet, FunctionDiff, OverlayNode } from "../types";
import { useRequest } from "../useRequest";
import { ChangedFunctions, CodePane } from "./CodePane";

vi.mock("../useRequest", () => ({ useRequest: vi.fn() }));

const node: OverlayNode = {
  id: "segments.views:create_segment", kind: "function", status: "changed", module: "segments.views",
  name: "create_segment", qualname: "create_segment", file: "api/segments/views.py", line: 48, end_line: 50,
  in_base: true, in_head: true, lines_added: 1, lines_removed: 1,
};

it("shows separate base and head gutters and marks added and removed diff rows", () => {
  const diff: FunctionDiff = {
    node: node.id, base: "before", head: "after", file: node.file, status: "changed",
    lines_added: 1, lines_removed: 1,
    rows: [
      { kind: "context", base_line: 36, head_line: 48, text: "def create_segment():" },
      { kind: "removed", base_line: 37, head_line: null, text: "    return 1" },
      { kind: "added", base_line: null, head_line: 49, text: "    return 2" },
    ],
  };
  vi.mocked(useRequest).mockReturnValueOnce({ status: "ready", data: { diff } });
  const markup = renderToStaticMarkup(<CodePane repo="demo" head="after" node={node} nodes={[node]} open
    onOpenChange={vi.fn()} onSelect={vi.fn()} onClear={vi.fn()} />);

  expect(markup).toContain('aria-label="Diff for create_segment"');
  expect(markup).toContain('title="api/segments/views.py">…/segments/views.py<');
  expect(markup).toContain(">Changed<");
  expect(markup).toContain('data-revision="base">36</span><span class="code-line__number" data-revision="head">48<');
  expect(markup).toMatch(/code-line--removed.*data-revision="base">37<.*data-revision="head"><.*code-line__marker">−<.*    return 1/);
  expect(markup).toMatch(/code-line--added.*data-revision="base"><.*data-revision="head">49<.*code-line__marker">\+<.*    return 2/);
});

it("offers changed functions in the empty state and selects the node on click", () => {
  const onSelect = vi.fn();
  const context = { ...node, id: "get_segment", qualname: "get_segment", status: "context" } as const;
  const added = { ...node, id: "publish", qualname: "publish", status: "added", lines_added: 16, lines_removed: 0 } as const;
  const empty = ChangedFunctions({ nodes: [node, added, context], onSelect });
  const markup = renderToStaticMarkup(empty);
  expect(markup).toContain("Click a function in the flow to see what changed");
  expect(markup).toContain(">create_segment<");
  expect(markup).toContain(">+1<");
  expect(markup).toContain(">−1<");
  expect(markup).toContain(">+16<");
  expect(markup).not.toContain(">−0<");
  expect(markup).not.toContain("get_segment");

  const [, list] = empty.props.children;
  const [row] = list.props.children;
  row.props.children.props.onClick();
  expect(onSelect).toHaveBeenCalledWith(node);
});

it("omits a zero side from the source heading", () => {
  const removed = { ...node, status: "removed", lines_added: 0, lines_removed: 16 } as const;
  vi.mocked(useRequest).mockReturnValueOnce({ status: "loading" });
  const markup = renderToStaticMarkup(<CodePane repo="demo" head="after" node={removed} nodes={[removed]} open
    onOpenChange={vi.fn()} onSelect={vi.fn()} onClear={vi.fn()} />);

  expect(markup).toContain('class="line-counts__removed">−16<');
  expect(markup).not.toContain(">+0<");
});

it("shows a head snippet and highlights the selected flag check", () => {
  const check = { file: node.file, line: 49, function: node.id, call: "is_feature_enabled" };
  const snippet: CodeSnippet = {
    sha: "abcdefg123", file: check.file, start: 48, end: 50,
    lines: [
      { number: 48, text: "def create_segment():" },
      { number: 49, text: '    if is_feature_enabled("create_segment"):' },
      { number: 50, text: "        return 2" },
    ],
  };
  vi.mocked(useRequest).mockReturnValueOnce({ status: "ready", data: { snippet } });
  const markup = renderToStaticMarkup(<CodePane repo="demo" head={snippet.sha} check={check} nodes={[node]} open
    onOpenChange={vi.fn()} onSelect={vi.fn()} onClear={vi.fn()} />);

  expect(markup).toContain('>Head abcdefg<');
  expect(markup).toContain('class="code-line is-highlighted"><span class="code-line__number">49<');
  expect(markup).toContain('aria-label="Source for api/segments/views.py:49"');
});
