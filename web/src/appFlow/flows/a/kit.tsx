// Flow A "Guided": the pieces its screens share, from the flow A style sheet and screens.
// Sizes and spacing live in kit.css; colours, type and button shape come from the tokens
// (docs/APP_FLOW_BUILD.md, "Token vocabulary").
import type { ReactNode } from "react";
import { AppLink } from "../../../AppLink";
import "./kit.css";

export type IconName =
  | "github"
  | "arrow-right"
  | "arrow-up"
  | "arrow-down"
  | "arrow-left"
  | "branch"
  | "check"
  | "chevron-down"
  | "chevron-right"
  | "close"
  | "code"
  | "external"
  | "flag"
  | "layers"
  | "lock"
  | "plus"
  | "refresh"
  | "repo"
  | "search"
  | "info"
  | "commit";

// Stroke paths on a 24 x 24 grid, copied from the flow A designs. search, commit and the arrows,
// code, flag, layers and refresh icons are not all in the designs, so they use the same stroke style.
const ICON_PATHS: Record<IconName, readonly string[]> = {
  github: ["M9 19c-4 1-4-2-6-2m12 5v-3.9a3.4 3.4 0 0 0-.9-2.5c3-.3 6.1-1.5 6.1-6.7a5.2 5.2 0 0 0-1.4-3.6 4.8 4.8 0 0 0-.1-3.6S17.7 1.4 15 3a13.4 13.4 0 0 0-6 0C6.3 1.4 5.3 1.7 5.3 1.7a4.8 4.8 0 0 0-.1 3.6A5.2 5.2 0 0 0 3.8 9c0 5.1 3.1 6.3 6.1 6.7a3.4 3.4 0 0 0-.9 2.7V22"],
  "arrow-right": ["M4 12h15m-6-6 6 6-6 6"],
  "arrow-up": ["M12 19V5", "m5 12 7-7 7 7"],
  "arrow-down": ["M12 5v14", "m19 12-7 7-7-7"],
  "arrow-left": ["M19 12H5", "m12 19-7-7 7-7"],
  branch: ["M6 6v10m12-10v2a4 4 0 0 1-4 4H6m0-9a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm0 13a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM18 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"],
  check: ["m5 12 4 4L19 6"],
  "chevron-down": ["m6 9 6 6 6-6"],
  "chevron-right": ["m9 6 6 6-6 6"],
  close: ["m6 6 12 12M18 6 6 18"],
  code: ["m16 18 6-6-6-6", "m8 6-6 6 6 6"],
  external: ["M14 4h6v6m0-6-9 9m-1-7H5v13h13v-5"],
  flag: ["M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z", "M4 22v-7"],
  layers: ["M12 3 3 7.5l9 4.5 9-4.5L12 3Z", "m3 12 9 4.5 9-4.5", "m3 16.5 9 4.5 9-4.5"],
  lock: ["M6 10h12v10H6zM8 10V8a4 4 0 0 1 8 0v2m-4 4v2"],
  plus: ["M12 5v14M5 12h14"],
  refresh: ["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5"],
  search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z", "m20 20-4-4"],
  info: ["M12 11v5m0-8h.01", "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z"],
  commit: ["M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z", "M3 12h5m8 0h5"],
  repo: ["M7 4h12v16H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm-2 13h14M9 8h6m-6 4h4"],
};

/** A decorative stroke icon. Name it with the text or aria-label next to it. */
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="fa-icon"
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

/** The account picture, or its first letter on the accent tint. Decorative: the login is always written next to it. */
export function Avatar({ login, src }: { login: string; src?: string }) {
  return (
    <span className="fa-avatar" aria-hidden="true">
      {src ? <img src={src} alt="" /> : login.charAt(0).toUpperCase()}
    </span>
  );
}

/** The 64 px top bar. The logo goes to the start page; `children` follow it on the left, `right` sits at the far end. */
export function Header({ children, right }: { children?: ReactNode; right?: ReactNode }) {
  return (
    <header className="fa-header">
      <div className="fa-header__inner">
        <div className="fa-header__start">
          <AppLink href="/" className="fa-header__brand">
            <span className="fa-header__mark" aria-hidden="true">↳</span>
            <span className="fa-header__name">code-flow</span>
          </AppLink>
          {children}
        </div>
        {right && <div className="fa-header__end">{right}</div>}
      </div>
    </header>
  );
}

const STEP_LABELS = ["Sign in", "Choose a repo", "Choose a branch", "See the flow"];

/** The 4-step indicator. Steps before `step` are done; `step` itself is the current one (aria-current). */
export function Stepper({ step }: { step: 1 | 2 | 3 | 4 }) {
  return (
    <ol className="fa-stepper" aria-label="Setup progress">
      {STEP_LABELS.map((label, index) => {
        const number = index + 1;
        const state = number < step ? "done" : number === step ? "current" : "upcoming";
        return (
          <li
            key={label}
            className={`fa-stepper__step fa-stepper__step--${state}`}
            aria-current={state === "current" ? "step" : undefined}
          >
            <span className="fa-stepper__marker">
              {state === "done" ? <Icon name="check" size={14} /> : number}
            </span>
            <span className="fa-stepper__label">
              {state === "done" && <span className="fa-sr-only">Done: </span>}
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** A white card with the flow's 16 px radius and card shadow. */
export function Card({ padding = "regular", className, children }: {
  padding?: "compact" | "regular" | "roomy";
  className?: string;
  children: ReactNode;
}) {
  return <div className={cx("fa-card", `fa-card--${padding}`, className)}>{children}</div>;
}

/** The centred 720 px column that holds one task per page. */
export function PageColumn({ className, children }: { className?: string; children: ReactNode }) {
  return <main className={cx("fa-page", className)}>{children}</main>;
}

export type ChipTone = "neutral" | "accent" | "added" | "removed" | "changed";

/** A small status or count label: Private, Ready, +1, ~1. The diagram tones match the diagram colours. */
export function Chip({ tone = "neutral", children }: { tone?: ChipTone; children: ReactNode }) {
  return <span className={`fa-chip fa-chip--${tone}`}>{children}</span>;
}

/** A notice box with an info icon. Use role "alert" for an error that appears after an action. */
export function Callout({ role, children }: { role?: "alert" | "status"; children: ReactNode }) {
  return (
    <div className="fa-callout" role={role}>
      <Icon name="info" size={18} />
      <div>{children}</div>
    </div>
  );
}

function cx(...names: (string | false | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}
