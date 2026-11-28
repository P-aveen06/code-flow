import type { ButtonHTMLAttributes } from "react";
import { AppLink } from "../../AppLink";

export type ButtonVariant = "primary" | "secondary" | "tertiary";
export type ButtonSize = "md" | "sm";

export type ButtonProps = ButtonHTMLAttributes<HTMLElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Renders a plain link to this address. */
  href?: string;
  /** Renders an in-app link to this path. AppLink takes only a label, so other props are not passed on. */
  to?: string;
};

/**
 * The shared button. It uses today's `.btn` classes, shaped by the ui_buttons tokens, and renders
 * a <button> (type "button" unless given), an <a href>, or an in-app AppLink for `to`.
 */
export function Button({
  variant = "secondary", size = "md", href, to, className, type = "button", children, ...rest
}: ButtonProps) {
  const classes = ["btn", `btn--${variant}`, size === "sm" && "btn--sm", className].filter(Boolean).join(" ");
  if (to !== undefined) {
    return <AppLink href={to} className={classes} label={rest["aria-label"]}>{children}</AppLink>;
  }
  if (href !== undefined) {
    // A link has no disabled state, so a disabled link is only marked for assistive technology.
    const { disabled, ...linkProps } = rest;
    return (
      <a href={href} className={classes} aria-disabled={disabled || undefined} {...linkProps}>
        {children}
      </a>
    );
  }
  return <button type={type} className={classes} {...rest}>{children}</button>;
}
