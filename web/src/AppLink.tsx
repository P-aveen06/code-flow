import type { ReactNode } from "react";
import { navigate } from "./router";

export function AppLink({ href, className, children, label, onClick }: {
  href: string;
  className?: string;
  children: ReactNode;
  label?: string;
  // Runs on every click, before the in-app navigation.
  onClick?: () => void;
}) {
  return (
    <a
      href={href}
      className={className}
      aria-label={label}
      onClick={(event) => {
        onClick?.();
        if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}
