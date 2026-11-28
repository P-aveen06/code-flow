// @vitest-environment happy-dom

import type { ReactNode } from "react";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../../../types";
import { AvatarMenu, CanvasBackground, FloatingPanel, ModalSheet, Pill } from "./kit";

let root: Root;
let container: HTMLDivElement;

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}

function keyDown(key: string, shiftKey = false) {
  return new KeyboardEvent("keydown", { key, shiftKey, bubbles: true });
}

const SIGNED_IN: Me = {
  configured: true,
  signed_in: true,
  login: "demo-user",
  avatar_url: "https://avatars.example/1.png",
  install_url: "https://github.example/apps/code-flow/installations/new",
};

// An opener button, and a sheet whose close also records the call.
function SheetHarness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Analyze</button>
      <ModalSheet
        open={open}
        title="Analyze a repository"
        onClose={() => {
          setOpen(false);
          onClose();
        }}
      >
        <button type="button">Choose branch</button>
      </ModalSheet>
    </>
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

describe("Flow C kit", () => {
  it("moves focus into the sheet, closes on Escape and returns focus to the opener", async () => {
    const onClose = vi.fn();
    await render(<SheetHarness onClose={onClose} />);
    const opener = container.querySelector<HTMLButtonElement>("button")!;

    opener.focus();
    await act(async () => opener.click());
    const dialog = container.querySelector("[role='dialog']");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(dialog);

    await act(async () => document.dispatchEvent(keyDown("Escape")));
    expect(onClose).toHaveBeenCalledOnce();
    expect(container.querySelector("[role='dialog']")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("keeps Tab and Shift+Tab inside the sheet", async () => {
    await render(<SheetHarness onClose={vi.fn()} />);
    const opener = container.querySelector<HTMLButtonElement>("button")!;
    opener.focus();
    await act(async () => opener.click());

    // Inside the sheet, the close button comes first and "Choose branch" last.
    const close = container.querySelector<HTMLButtonElement>(".fc-modal__close")!;
    const choose = Array.from(container.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")).at(-1)!;

    choose.focus();
    await act(async () => choose.dispatchEvent(keyDown("Tab")));
    expect(document.activeElement).toBe(close);

    await act(async () => close.dispatchEvent(keyDown("Tab", true)));
    expect(document.activeElement).toBe(choose);
  });

  it("closes from the close button and from a click on the backdrop, but not from a click inside", async () => {
    const onClose = vi.fn();
    await render(<SheetHarness onClose={onClose} />);
    const opener = container.querySelector<HTMLButtonElement>("button")!;
    opener.focus();
    await act(async () => opener.click());

    const dialog = container.querySelector<HTMLDivElement>("[role='dialog']")!;
    await act(async () => dialog.click());
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => container.querySelector<HTMLButtonElement>(".fc-modal__close")!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });

  it("shows who is signed in and calls onSignOut from the account menu", async () => {
    const onSignOut = vi.fn();
    await render(<AvatarMenu me={SIGNED_IN} onSignOut={onSignOut} />);

    expect(container.querySelector(".fc-menu__who")?.textContent).toBe("Signed in as @demo-user");
    const signOut = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Sign out");
    await act(async () => signOut!.click());
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it("renders nothing in the account menu when nobody is signed in", async () => {
    await render(<AvatarMenu me={{ configured: true, signed_in: false }} onSignOut={vi.fn()} />);

    expect(container.innerHTML).toBe("");
  });

  it("labels a floating panel with its title and marks diagram pills with their tone", async () => {
    await render(
      <CanvasBackground>
        <FloatingPanel title="Commits">
          <Pill tone="added">+1</Pill>
        </FloatingPanel>
      </CanvasBackground>,
    );

    const panel = container.querySelector("section");
    const titleId = panel?.getAttribute("aria-labelledby");
    expect(container.querySelector(`[id="${titleId}"]`)?.textContent).toBe("Commits");
    expect(container.querySelector(".fc-canvas .fc-pill.fc-pill--added")?.textContent).toBe("+1");
  });
});
