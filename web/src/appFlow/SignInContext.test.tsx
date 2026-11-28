// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignInProvider, useSignIn } from "./SignInContext";
import type { Piece } from "./types";

let root: Root;
let container: HTMLDivElement;

const cancelled = "GitHub sign-in was cancelled.";

// Reports the sign-in state as text, and has a button that runs the landing's sign-in action.
// The inline panel is only on the landing page, as in the app.
function Probe() {
  const sign = useSignIn();
  const onLanding = window.location.pathname === "/";
  return (
    <div>
      <p data-testid="state">{[sign.piece, sign.modalOpen ? "open" : "closed", sign.error ?? "no error"].join("|")}</p>
      <button type="button" onClick={sign.start}>Sign in with GitHub</button>
      <div id="import" tabIndex={-1} />
      {onLanding && <section id="signin-panel" tabIndex={-1} />}
    </div>
  );
}

async function render(piece: Piece, url: string, ready = true) {
  window.history.replaceState(null, "", url);
  await act(async () => root.render(<SignInProvider piece={piece} ready={ready}><Probe /></SignInProvider>));
}

function state() {
  return container.querySelector('[data-testid="state"]')?.textContent;
}

async function clickSignIn() {
  await act(async () => container.querySelector("button")?.click());
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
  window.history.replaceState(null, "", "/");
});

describe("start", () => {
  it("scrolls to and focuses the import section for today", async () => {
    await render("today", "/");
    await clickSignIn();
    expect(document.activeElement?.id).toBe("import");
  });

  it("opens the sign-in page for flow A", async () => {
    await render("a", "/");
    await clickSignIn();
    expect(window.location.pathname).toBe("/signin");
  });

  it("focuses the inline panel for flow B when it is on the page", async () => {
    await render("b", "/");
    await clickSignIn();
    expect(document.activeElement?.id).toBe("signin-panel");
  });

  it("goes to the landing page for flow B when the panel is elsewhere", async () => {
    await render("b", "/github");
    await clickSignIn();
    expect(window.location.pathname).toBe("/");
  });

  it("opens the modal for flow C, and closing it hides the modal", async () => {
    await render("c", "/");
    expect(state()).toBe("c|closed|no error");
    await clickSignIn();
    expect(state()).toBe("c|open|no error");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => container.querySelector<HTMLButtonElement>('[role="dialog"] button')?.click());
    expect(state()).toBe("c|closed|no error");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("a failed sign-in", () => {
  it("is forwarded to /signin for flow A", async () => {
    await render("a", "/?signin_error=denied");
    expect(window.location.pathname).toBe("/signin");
    expect(window.location.search).toBe("?signin_error=denied");
  });

  it("opens the modal with the message for flow C, and leaves the URL clean", async () => {
    await render("c", "/?signin_error=denied");
    expect(state()).toBe(`c|open|${cancelled}`);
    expect(window.location.search).toBe("");
  });

  it("is shown by the panel for flow B, and leaves the URL clean", async () => {
    await render("b", "/?signin_error=denied");
    expect(state()).toBe(`b|closed|${cancelled}`);
    expect(window.location.search).toBe("");
  });

  it("is left to today's landing page", async () => {
    await render("today", "/?signin_error=denied");
    expect(state()).toBe("today|closed|no error");
    expect(window.location.search).toBe("?signin_error=denied");
  });

  it("waits until the flags are ready", async () => {
    await render("a", "/?signin_error=denied", false);
    expect(window.location.pathname).toBe("/");
    await act(async () => root.render(<SignInProvider piece="a" ready><Probe /></SignInProvider>));
    expect(window.location.pathname).toBe("/signin");
  });

  it("ignores codes that are not known", async () => {
    await render("c", "/?signin_error=unknown");
    expect(state()).toBe("c|closed|no error");
  });
});
