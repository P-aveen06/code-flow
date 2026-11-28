// Flow C "Canvas": the pieces its screens share, from the flow C style sheet and screens.
// Diagram first: a full-bleed canvas with floating panels, small pills, an avatar menu and a modal sheet.
// Sizes and spacing live in kit.css; colours, type and button shape come from the tokens
// (docs/APP_FLOW_BUILD.md, "Token vocabulary").
import { useEffect, useId, useRef, type ReactNode } from "react";
import { AppLink } from "../../../AppLink";
import type { Me } from "../../../types";
import "./kit.css";

export type IconName =
  | "github"
  | "arrow-right"
  | "branch"
  | "check"
  | "chevron-down"
  | "close"
  | "external"
  | "lock"
  | "plus"
  | "search"
  | "info"
  | "commit"
  | "chevron-right"
  | "help"
  | "refresh";

// Stroke paths on a 24 x 24 grid, copied from the flow C designs. search, commit, help and refresh
// are not in the designs, so they use the same stroke style.
const ICON_PATHS: Record<IconName, readonly string[]> = {
  github: ["M9 19c-4 1.2-4-2-5.5-2.5M15 22v-3a2.6 2.6 0 0 0-.7-2c2.5-.3 5.2-1.2 5.2-5.6 0-1.2-.4-2.2-1.2-3 .1-.3.5-1.4-.1-3-1 0-2.5.6-3.2 1.1a13 13 0 0 0-6 0c-.7-.5-2.2-1.1-3.2-1.1-.6 1.6-.2 2.7-.1 3-.8.8-1.2 1.8-1.2 3 0 4.4 2.7 5.3 5.2 5.6-.5.5-.7 1.2-.7 2v3"],
  "arrow-right": ["M4 12h15m-6-6 6 6-6 6"],
  branch: ["M6 6v10m12-10v2a4 4 0 0 1-4 4H6m0-9a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm0 13a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM18 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"],
  check: ["m5 12 4 4L19 6"],
  "chevron-down": ["m6 9 6 6 6-6"],
  close: ["m6 6 12 12M18 6 6 18"],
  external: ["M14 4h6v6m0-6-9 9m-1-7H5v13h13v-5"],
  lock: ["M6 10h12v10H6zM8 10V8a4 4 0 0 1 8 0v2m-4 4v2"],
  plus: ["M12 5v14M5 12h14"],
  search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z", "m20 20-4-4"],
  info: ["M12 11v5m0-8h.01", "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z"],
  commit: ["M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z", "M3 12h5m8 0h5"],
  "chevron-right": ["m9 6 6 6-6 6"],
  help: ["M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6", "M12 17h.01", "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z"],
  refresh: ["M20 12a8 8 0 1 1-2.3-5.6", "M20 4v5h-5"],
};

/** A decorative stroke icon. Name it with the text or aria-label next to it. */
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="fc-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICON_PATHS[name].map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

/** The account picture, or its first letter on the tonal circle. Decorative: the login is always written next to it. */
export function Avatar({ login, src }: { login: string; src?: string }) {
  return (
    <span className="fc-avatar" aria-hidden="true">
      {src ? <img src={src} alt="" /> : login.charAt(0).toUpperCase()}
    </span>
  );
}

/** The 64 px top bar. `children` follow the logo on the left, `right` sits at the far end. */
export function Header({ children, right }: { children?: ReactNode; right?: ReactNode }) {
  return (
    <header className="fc-header">
      <div className="fc-header__start">
        <AppLink href="/" className="fc-header__brand">
          <span className="fc-header__mark" aria-hidden="true">↳</span>
          <span className="fc-header__name">code-flow</span>
        </AppLink>
        {children}
      </div>
      {right && <div className="fc-header__end">{right}</div>}
    </header>
  );
}

/** The account in the header: a menu that says who is signed in and signs out. Renders nothing when signed out. */
export function AvatarMenu({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  if (!me.signed_in) return null;
  return (
    <details className="fc-menu">
      <summary className="fc-menu__summary">
        <Avatar login={me.login} src={me.avatar_url} />
        <span className="fc-menu__login">@{me.login}</span>
        <Icon name="chevron-down" size={14} />
      </summary>
      <div className="fc-menu__popover">
        <p className="fc-menu__who">Signed in as @{me.login}</p>
        <button type="button" className="btn btn--tertiary btn--sm" onClick={() => onSignOut()}>
          Sign out
        </button>
      </div>
    </details>
  );
}

/** A white panel that floats over the canvas, with the 16 px radius and panel shadow. `title` labels it. */
export function FloatingPanel({ title, className, children }: {
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section className={cx("fc-panel", className)} aria-labelledby={title ? titleId : undefined}>
      {title && <h2 id={titleId} className="fc-panel__title">{title}</h2>}
      {children}
    </section>
  );
}

export type PillTone = "neutral" | "added" | "removed" | "changed";

/** A small rounded label. The diagram tones match the diagram colours and use the mono face. */
export function Pill({ tone = "neutral", children }: { tone?: PillTone; children: ReactNode }) {
  return <span className={`fc-pill fc-pill--${tone}`}>{children}</span>;
}

/** A full-bleed area in the canvas colour with a dot grid. Floating panels go inside it. */
export function CanvasBackground({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("fc-canvas", className)}>{children}</div>;
}

const FOCUSABLE =
  "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

// Keeps Tab and Shift+Tab inside the dialog, wrapping at both ends.
function keepFocusInside(event: KeyboardEvent, dialog: HTMLElement) {
  const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
  const first = items[0] ?? dialog;
  const last = items[items.length - 1] ?? dialog;
  const active = document.activeElement;
  const outside = !dialog.contains(active);
  if (event.shiftKey) {
    if (outside || active === first || active === dialog) {
      event.preventDefault();
      last.focus();
    }
  } else if (outside || active === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * A dialog over a dimmed backdrop. When it opens, focus moves into it and Tab stays inside it.
 * Escape, the close button and a click on the backdrop call onClose. Focus returns to the
 * element that had it before the dialog opened.
 */
export function ModalSheet({ open, title, onClose, children }: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
      } else if (event.key === "Tab" && dialog) {
        keepFocusInside(event, dialog);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      opener?.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="fc-modal"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="fc-modal__dialog"
      >
        <div className="fc-modal__head">
          <h2 id={titleId} className="fc-modal__title">{title}</h2>
          <button type="button" className="fc-modal__close" aria-label="Close" onClick={() => onCloseRef.current()}>
            <Icon name="close" size={14} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function cx(...names: (string | false | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}
