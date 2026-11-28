// What a landing's main "Sign in with GitHub" button does for the sign-in piece, and where a failed
// sign-in is shown (docs/APP_FLOW_BUILD.md, "Sign-in across mixed pieces").
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { readSigninError } from "../pages/Landing";
import { navigate } from "../router";
import { SignInModalC } from "./flows/c/SignIn";
import type { Piece } from "./types";

const signinErrorParam = "signin_error";

export interface SignInState {
  piece: Piece;
  start(): void;
  modalOpen: boolean;
  openModal(error?: string | null): void;
  closeModal(): void;
  // The message for a failed sign-in: shown by the panel (b) or the modal (c).
  error: string | null;
}

// Outside a SignInProvider, sign-in behaves as today.
const todaySignIn: SignInState = {
  piece: "today",
  start: () => focusElement("import"),
  modalOpen: false,
  openModal() {},
  closeModal() {},
  error: null,
};

const SignInContext = createContext<SignInState>(todaySignIn);

interface FailedSignIn {
  code: string;
  message: string;
}

// A failed sign-in returns to /?signin_error=<code>. Unknown codes are ignored.
function readFailedSignIn(search: string): FailedSignIn | null {
  const code = new URLSearchParams(search).get(signinErrorParam);
  const message = readSigninError(search);
  return code !== null && typeof message === "string" ? { code, message } : null;
}

function focusElement(id: string) {
  const element = document.getElementById(id);
  element?.scrollIntoView();
  element?.focus();
}

function removeSigninErrorParam() {
  const url = new URL(window.location.href);
  url.searchParams.delete(signinErrorParam);
  navigate(`${url.pathname}${url.search}${url.hash}`, { replace: true });
}

export function SignInProvider({ piece, ready, children }: {
  piece: Piece;
  // False until the flags are known, because the piece is not known before then.
  ready: boolean;
  children: ReactNode;
}) {
  // Read once, at first render. The error is handled below when the piece is known.
  const [failed, setFailed] = useState(() => readFailedSignIn(window.location.search));
  const [modalOpen, setModalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The element to focus once the landing page has rendered it (after start() navigated there).
  const focusPending = useRef<string | null>(null);

  const openModal = useCallback((message?: string | null) => {
    setError(message ?? null);
    setModalOpen(true);
  }, []);

  const closeModal = useCallback(() => setModalOpen(false), []);

  const start = useCallback(() => {
    // Today's #import section and B's panel live on the landing page: go there first if needed.
    const focusOnLanding = (id: string) => {
      if (document.getElementById(id)) {
        focusElement(id);
      } else {
        focusPending.current = id;
        navigate("/");
      }
    };
    switch (piece) {
      case "today":
        focusOnLanding("import");
        return;
      case "a":
        navigate("/signin");
        return;
      case "b":
        focusOnLanding("signin-panel");
        return;
      case "c":
        openModal();
        return;
    }
  }, [piece, openModal]);

  useEffect(() => {
    if (!ready || failed === null) return;
    setFailed(null);
    if (piece === "today") return; // Today's landing reads the parameter itself.
    if (piece === "a") {
      navigate(`/signin?${signinErrorParam}=${encodeURIComponent(failed.code)}`, { replace: true });
      return;
    }
    setError(failed.message);
    if (piece === "c") setModalOpen(true);
    removeSigninErrorParam();
  }, [ready, piece, failed]);

  useEffect(() => {
    const id = focusPending.current;
    if (id === null || !document.getElementById(id)) return;
    focusPending.current = null;
    focusElement(id);
  });

  const value: SignInState = { piece, start, modalOpen, openModal, closeModal, error };
  return (
    <SignInContext.Provider value={value}>
      {children}
      {piece === "c" && <SignInModalC open={modalOpen} error={error} onClose={closeModal} />}
    </SignInContext.Provider>
  );
}

export function useSignIn(): SignInState {
  return useContext(SignInContext);
}
