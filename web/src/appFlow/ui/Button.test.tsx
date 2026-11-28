// @vitest-environment happy-dom

import type { ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "./Button";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

async function render(element: ReactElement) {
  await act(async () => root.render(element));
}

describe("Button", () => {
  it("renders today's secondary button by default, with type button", async () => {
    await render(<Button>Analyze</Button>);
    const button = container.querySelector("button");
    expect(button?.className).toBe("btn btn--secondary");
    expect(button?.type).toBe("button");
  });

  it("maps variant, size and className onto classes, and renders a link for href", async () => {
    await render(<Button variant="primary" size="sm" href="https://example.com/docs" className="extra">Docs</Button>);
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/docs");
    expect(link?.className).toBe("btn btn--primary btn--sm extra");
  });

  it("renders an in-app link for to and navigates without a page load", async () => {
    await render(<Button variant="primary" to="/github" aria-label="Choose a repository">Choose</Button>);
    const link = container.querySelector("a");
    expect(link?.className).toBe("btn btn--primary");
    expect(link?.getAttribute("aria-label")).toBe("Choose a repository");
    await act(async () => link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(window.location.pathname).toBe("/github");
  });

  it("forwards aria attributes, disabled and click handlers to the button", async () => {
    const onClick = vi.fn();
    await render(<Button aria-label="Close" onClick={onClick}>x</Button>);
    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Close");
    await act(async () => button?.click());
    expect(onClick).toHaveBeenCalledTimes(1);

    await render(<Button disabled onClick={onClick}>x</Button>);
    expect(container.querySelector("button")?.disabled).toBe(true);
    await act(async () => container.querySelector("button")?.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("keeps the type a form asks for", async () => {
    await render(<Button type="submit">Save</Button>);
    expect(container.querySelector("button")?.type).toBe("submit");
  });
});
