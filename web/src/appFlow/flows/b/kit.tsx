// Flow B "Workbench": the pieces its screens share, from the flow B style sheet and screens.
// Dense and tool-like: a sidebar shell, panels with header bars, grid tables and a status strip.
// Sizes and spacing live in kit.css; colours, type and button sizes come from the tokens
// (docs/APP_FLOW_BUILD.md, "Token vocabulary").
import { Children, useId, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { AppLink } from "../../../AppLink";
import { navigate } from "../../../router";
import "./kit.css";

export type IconName =
  | "github"
  | "arrow-right"
  | "arrow-left"
  | "branch"
  | "check"
  | "chevron-down"
  | "close"
  | "external"
  | "globe"
  | "graph"
  | "lock"
  | "play"
  | "plus"
  | "repo"
  | "sign-out"
  | "search"
  | "info"
  | "commit"
  | "refresh"
  | "list"
  | "code"
  | "flag"
  | "flow"
  | "columns"
  | "link"
  | "clock"
  | "logout";

// Stroke paths on a 24 x 24 grid, copied from the flow B designs. search, commit, repo, refresh,
// list, code and flag are not in the designs, so they use the same stroke style. The rounded
// rectangles of the designs are written as paths, since the icon only draws paths.
const ICON_PATHS: Record<IconName, readonly string[]> = {
  github: ["M9 19c-4 1-4-2-6-2m12 5v-3.9a3.4 3.4 0 0 0-.9-2.5c3-.3 6.1-1.5 6.1-6.7a5.2 5.2 0 0 0-1.4-3.6 4.8 4.8 0 0 0-.1-3.6S17.7 1.4 15 3a13.4 13.4 0 0 0-6 0C6.3 1.4 5.3 1.7 5.3 1.7a4.8 4.8 0 0 0-.1 3.6A5.2 5.2 0 0 0 3.8 9c0 5.1 3.1 6.3 6.1 6.7a3.4 3.4 0 0 0-.9 2.7V22"],
  "arrow-right": ["M4 12h15m-6-6 6 6-6 6"],
  "arrow-left": ["M20 12H5m6-6-6 6 6 6"],
  branch: ["M6 6v10m12-10v2a4 4 0 0 1-4 4H6m0-9a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm0 13a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM18 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"],
  check: ["m5 12 4 4L19 6"],
  "chevron-down": ["m6 9 6 6 6-6"],
  close: ["m6 6 12 12M18 6 6 18"],
  external: ["M14 4h6v6m0-6-9 9m-1-7H5v13h13v-5"],
  globe: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M12 3a4 9 0 1 0 0 18 4 9 0 0 0 0-18Z", "M3 12h18"],
  graph: ["M3 3h6v6H3zM15 15h6v6h-6zM3 15h6v6H3z", "M6 9v6m3-9h9v9"],
  lock: ["M6 10h12v10H6zM8 10V8a4 4 0 0 1 8 0v2m-4 4v2"],
  play: ["m8 5 11 7-11 7z"],
  plus: ["M12 5v14M5 12h14"],
  repo: ["M5 19a2 2 0 0 1 2-2h12M7 3h12v18H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm2 4h6m-6 4h4"],
  "sign-out": ["M10 5H5v14h5m-1-7h11m-4-4 4 4-4 4"],
  search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z", "m20 20-4-4"],
  info: ["M12 11v5m0-8h.01", "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z"],
  commit: ["M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z", "M3 12h5m8 0h5"],
  refresh: ["M20 12a8 8 0 1 1-2.34-5.66", "M20 4v5h-5"],
  list: ["M9 6h11M9 12h11M9 18h11", "M4.5 6h.01M4.5 12h.01M4.5 18h.01"],
  code: ["m8 7-5 5 5 5", "m16 7 5 5-5 5"],
  flag: ["M5 21V4", "M5 4h11l-2 4 2 4H5"],
  flow: [
    "M4 3h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z",
    "M16 15h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1Z",
    "M4 15h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1Z",
    "M6 9v6m3-9h9v9",
  ],
  columns: ["M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z", "M9 4v16m6-16v16"],
  link: ["M10 13a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-2 2m3 5a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l2-2"],
  clock: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M12 7v5l3 2"],
  logout: ["M10 5H5v14h5m-1-7h11m-4-4 4 4-4 4"],
};

/** A decorative stroke icon. Name it with the text or aria-label next to it. */
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="fb-icon"
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
    <span className="fb-avatar" aria-hidden="true">
      {src ? <img src={src} alt="" /> : login.charAt(0).toUpperCase()}
    </span>
  );
}

/** The logo: a mark in a dark square and the lowercase wordmark. Goes to the start page. */
function Brand() {
  return (
    <AppLink href="/" className="fb-brand">
      <span className="fb-brand__mark" aria-hidden="true">↳</span>
      <span className="fb-brand__name">code-flow</span>
    </AppLink>
  );
}

/** The 64 px top bar. `children` follow the logo on the left (breadcrumbs), `right` sits at the far end. */
export function Header({ children, right }: { children?: ReactNode; right?: ReactNode }) {
  return (
    <header className="fb-header">
      <div className="fb-header__start">
        <Brand />
        {children}
      </div>
      {right && <div className="fb-header__end">{right}</div>}
    </header>
  );
}

/** Sidebar on the left (240 px), page on the right. */
export function AppShell({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <div className="fb-shell">
      <aside className="fb-shell__sidebar">{sidebar}</aside>
      <main className="fb-shell__main">{children}</main>
    </div>
  );
}

/** The sidebar column: the logo, the account block when given, then the navigation links. */
export function Sidebar({ label, account, children }: { label: string; account?: ReactNode; children: ReactNode }) {
  return (
    <div className="fb-sidebar">
      <div className="fb-sidebar__brand">
        <Brand />
      </div>
      {account && <div className="fb-sidebar__account">{account}</div>}
      <nav className="fb-sidebar__nav" aria-label={label}>
        {children}
      </nav>
    </div>
  );
}

/** A navigation link in the sidebar. The active one gets aria-current="page". */
export function SidebarLink({ href, active = false, children }: { href: string; active?: boolean; children: ReactNode }) {
  return (
    <a
      href={href}
      className={cx("fb-sidebar__link", active && "fb-sidebar__link--active")}
      aria-current={active ? "page" : undefined}
      onClick={(event) => {
        // Plain left clicks stay in the app, as AppLink does; modified clicks keep the browser's behaviour.
        if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

/** A bordered panel with a title bar. `actions` sit at the right of the bar; the body scrolls. */
export function Panel({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const titleId = useId();
  return (
    <section className="fb-panel" aria-labelledby={titleId}>
      <header className="fb-panel__header">
        <h2 id={titleId} className="fb-panel__title">{title}</h2>
        {actions && <div className="fb-panel__actions">{actions}</div>}
      </header>
      <div className="fb-panel__body">{children}</div>
    </section>
  );
}

/** A strip of small controls above a panel or table. */
export function Toolbar({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="fb-toolbar">
      {children}
    </div>
  );
}

/** A grid table. `columns` is the grid-template-columns that every row uses, e.g. "minmax(0, 1fr) 96px". */
export function Table({ label, columns, head, children }: {
  label: string;
  columns: string;
  head: readonly ReactNode[];
  children: ReactNode;
}) {
  return (
    <div role="table" aria-label={label} className="fb-table" style={{ "--fb-columns": columns } as CSSProperties}>
      <div role="row" className="fb-table__head">
        {head.map((cell, index) => (
          <div key={index} role="columnheader" className="fb-table__cell">{cell}</div>
        ))}
      </div>
      {children}
    </div>
  );
}

/** One body row of a Table. Each child is one cell. `selected` gives the row the selected look. */
export function TableRow({ selected = false, children }: { selected?: boolean; children: ReactNode }) {
  return (
    <div role="row" aria-selected={selected} className={cx("fb-table__row", selected && "fb-table__row--selected")}>
      {Children.map(children, (cell) => (
        <div role="cell" className="fb-table__cell">{cell}</div>
      ))}
    </div>
  );
}

export interface Tab {
  id: string;
  label: string;
  icon?: ReactNode;
}

/** A tab list. Left and right arrows, Home and End move the focus and select the tab. */
export function Tabs({ tabs, active, onChange, label }: {
  tabs: readonly Tab[];
  active: string;
  onChange: (id: string) => void;
  label?: string;
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='tab']"));
    const current = Math.max(0, buttons.indexOf(event.target as HTMLButtonElement));
    const last = buttons.length - 1;
    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = current === last ? 0 : current + 1;
        break;
      case "ArrowLeft":
        next = current === 0 ? last : current - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    buttons[next].focus();
    onChange(tabs[next].id);
  }

  return (
    <div role="tablist" aria-label={label} className="fb-tabs" onKeyDown={handleKeyDown}>
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={cx("fb-tab", selected && "fb-tab--selected")}
            onClick={() => onChange(tab.id)}
          >
            {tab.icon}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** Progress through named steps (Queued, Cloning, Analyzing, Ready). Steps before `current` are done. */
export function StatusStrip({ label, steps, current, children }: {
  label: string;
  steps: readonly string[];
  current: number;
  children?: ReactNode;
}) {
  return (
    <div role="status" aria-label={label} className="fb-status">
      <ol className="fb-status__steps">
        {steps.map((step, index) => {
          const state = index < current ? "done" : index === current ? "current" : "upcoming";
          return (
            <li
              key={step}
              className={`fb-status__step fb-status__step--${state}`}
              aria-current={state === "current" ? "step" : undefined}
            >
              <span className="fb-status__bar" aria-hidden="true" />
              <span className="fb-status__label">{step}</span>
            </li>
          );
        })}
      </ol>
      {children}
    </div>
  );
}

function cx(...names: (string | false | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}
