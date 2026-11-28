// @vitest-environment happy-dom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Avatar, Callout, Card, Chip, Header, PageColumn, Stepper } from "./kit";

let root: Root;
let container: HTMLDivElement;

async function render(node: ReactNode) {
  await act(async () => root.render(node));
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

describe("Flow A kit", () => {
  it("marks the current step with aria-current and the earlier steps as done", async () => {
    await render(<Stepper step={2} />);

    expect(container.querySelectorAll("li")).toHaveLength(4);
    expect(container.querySelector("[aria-current='step']")?.textContent).toContain("Choose a repo");
    expect(container.querySelectorAll(".fa-stepper__step--done")).toHaveLength(1);
    expect(container.querySelectorAll(".fa-stepper__step--upcoming")).toHaveLength(2);
  });

  it("links the logo to the start page and renders the right-hand slot", async () => {
    await render(<Header right={<span>@demo-user</span>} />);

    const logo = container.querySelector("a");
    expect(logo?.getAttribute("href")).toBe("/");
    expect(logo?.textContent).toContain("code-flow");
    expect(container.textContent).toContain("@demo-user");
  });

  it("shows the first letter of the login, or the picture when there is one", async () => {
    await render(<Avatar login="demo-user" />);
    expect(container.textContent).toBe("D");

    await render(<Avatar login="demo-user" src="https://avatars.example/1.png" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://avatars.example/1.png");
  });

  it("announces an error callout as an alert", async () => {
    await render(<Callout role="alert">GitHub sign-in did not finish.</Callout>);

    expect(container.querySelector("[role='alert']")?.textContent).toContain("GitHub sign-in did not finish.");
  });

  it("applies the padding variant, chip tone and page column classes", async () => {
    await render(
      <PageColumn>
        <Card padding="roomy">Sign in</Card>
        <Chip tone="added">+1</Chip>
      </PageColumn>,
    );

    expect(container.querySelector("main.fa-page")).not.toBeNull();
    expect(container.querySelector(".fa-card.fa-card--roomy")?.textContent).toBe("Sign in");
    expect(container.querySelector(".fa-chip.fa-chip--added")?.textContent).toBe("+1");
  });
});
