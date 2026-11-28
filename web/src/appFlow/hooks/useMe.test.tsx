// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../../types";
import { useMe } from "./useMe";

vi.mock("../../config", () => ({ apiUrl: "https://flow.test" }));

const signedIn: Me = {
  configured: true, signed_in: true, login: "octo", avatar_url: "",
  install_url: "https://github.com/apps/code-flow/installations/new",
};
const signedOut: Me = { configured: true, signed_in: false };

let root: Root;
let container: HTMLDivElement;
let session: ReturnType<typeof useMe>;
let me: Me;
const mockFetch = vi.fn<typeof fetch>();

function Probe() {
  session = useMe();
  const { me: state } = session;
  if (state.status !== "ready") return <p>{state.status}</p>;
  return <p>{state.data.signed_in ? `signed in as ${state.data.login}` : "signed out"}</p>;
}

function requestedPaths() {
  return mockFetch.mock.calls.map(([input]) => new URL(String(input)).pathname);
}

beforeEach(() => {
  me = signedIn;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", mockFetch);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  mockFetch.mockReset();
});

describe("useMe sign-out", () => {
  it("ends the session and reads the account again", async () => {
    mockFetch.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/auth/logout") {
        me = signedOut;
        return new Response(null, { status: 204 });
      }
      return Response.json(me);
    });
    await act(async () => root.render(<Probe />));
    expect(container.textContent).toBe("signed in as octo");

    await act(async () => { await session.signOut(); });

    expect(container.textContent).toBe("signed out");
    expect(requestedPaths()).toEqual(["/api/me", "/api/auth/logout", "/api/me"]);
  });

  it("still reads the account again when the sign-out request fails", async () => {
    mockFetch.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/auth/logout") return new Response(null, { status: 500 });
      return Response.json(me);
    });
    await act(async () => root.render(<Probe />));

    let failure: unknown;
    await act(async () => {
      failure = await session.signOut().catch((error: unknown) => error);
    });

    expect((failure as Error).message).toBe("Could not sign out. Try again.");
    expect(requestedPaths()).toEqual(["/api/me", "/api/auth/logout", "/api/me"]);
    expect(container.textContent).toBe("signed in as octo");
  });
});
