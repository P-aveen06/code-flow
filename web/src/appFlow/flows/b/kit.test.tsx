// @vitest-environment happy-dom

import type { ReactNode } from "react";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell, Panel, Sidebar, SidebarLink, StatusStrip, Table, TableRow, Tabs } from "./kit";

let root: Root;
let container: HTMLDivElement;

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}

function keyDown(key: string) {
  return new KeyboardEvent("keydown", { key, bubbles: true });
}

const IMPORT_TABS = [
  { id: "github", label: "GitHub" },
  { id: "url", label: "Public URL" },
  { id: "sample", label: "Sample" },
];

function TabsHarness({ onChange }: { onChange: (id: string) => void }) {
  const [active, setActive] = useState("github");
  return (
    <Tabs
      tabs={IMPORT_TABS}
      active={active}
      label="Import method"
      onChange={(id) => {
        setActive(id);
        onChange(id);
      }}
    />
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("Flow B kit", () => {
  it("moves between tabs with the arrow keys, Home and End, and selects the focused tab", async () => {
    const onChange = vi.fn();
    await render(<TabsHarness onChange={onChange} />);
    const tabs = container.querySelectorAll<HTMLButtonElement>("[role='tab']");
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].tabIndex).toBe(-1);

    tabs[0].focus();
    await act(async () => tabs[0].dispatchEvent(keyDown("ArrowRight")));
    expect(onChange).toHaveBeenLastCalledWith("url");
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");

    await act(async () => tabs[1].dispatchEvent(keyDown("End")));
    expect(document.activeElement).toBe(tabs[2]);

    await act(async () => tabs[2].dispatchEvent(keyDown("ArrowRight")));
    expect(document.activeElement).toBe(tabs[0]);

    await act(async () => tabs[0].dispatchEvent(keyDown("ArrowLeft")));
    expect(document.activeElement).toBe(tabs[2]);

    await act(async () => tabs[2].dispatchEvent(keyDown("Home")));
    expect(document.activeElement).toBe(tabs[0]);
    expect(onChange).toHaveBeenLastCalledWith("github");
  });

  it("renders a labelled grid table whose selected row is marked", async () => {
    await render(
      <Table label="Repositories" columns="minmax(0, 1fr) 96px" head={["Name", "Branch"]}>
        <TableRow>
          <span>Flagsmith/flagsmith</span>
          <span>main</span>
        </TableRow>
        <TableRow selected>
          <span>demo-user/payments-api</span>
          <span>release</span>
        </TableRow>
      </Table>,
    );

    expect(container.querySelector("[role='table']")?.getAttribute("aria-label")).toBe("Repositories");
    expect(container.querySelectorAll("[role='columnheader']")).toHaveLength(2);
    expect(container.querySelectorAll("[role='cell']")).toHaveLength(4);
    const selected = container.querySelector(".fb-table__row--selected");
    expect(selected?.getAttribute("aria-selected")).toBe("true");
    expect(selected?.textContent).toContain("payments-api");
  });

  it("shows the steps before the current one as done and names the current step", async () => {
    await render(
      <StatusStrip label="Import progress" steps={["Queued", "Cloning", "Analyzing", "Ready"]} current={2}>
        <p>Analyzing commit 12 of 20</p>
      </StatusStrip>,
    );

    const status = container.querySelector("[role='status']");
    expect(status?.getAttribute("aria-label")).toBe("Import progress");
    expect(container.querySelector("[aria-current='step']")?.textContent).toBe("Analyzing");
    expect(container.querySelectorAll(".fb-status__step--done")).toHaveLength(2);
    expect(status?.textContent).toContain("Analyzing commit 12 of 20");
  });

  it("labels a panel with its title and keeps the actions in the title bar", async () => {
    await render(
      <Panel title="Tokens" actions={<button type="button">Copy</button>}>
        <p>Body text</p>
      </Panel>,
    );

    const panel = container.querySelector("section");
    const titleId = panel?.getAttribute("aria-labelledby");
    expect(container.querySelector(`[id="${titleId}"]`)?.textContent).toBe("Tokens");
    expect(container.querySelector(".fb-panel__header .fb-panel__actions button")?.textContent).toBe("Copy");
    expect(container.querySelector(".fb-panel__body")?.textContent).toBe("Body text");
  });

  it("renders the shell with the active sidebar link marked as the current page", async () => {
    const sidebar: ReactNode = (
      <Sidebar label="Workspace">
        <SidebarLink href="/github" active>Repositories</SidebarLink>
        <SidebarLink href="/github/analyzed">Analyzed</SidebarLink>
      </Sidebar>
    );
    await render(<AppShell sidebar={sidebar}><p>Page content</p></AppShell>);

    expect(container.querySelector("aside")).not.toBeNull();
    expect(container.querySelector("[aria-current='page']")?.textContent).toBe("Repositories");
    expect(container.querySelector("main")?.textContent).toBe("Page content");
  });
});
