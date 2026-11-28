import { useEffect } from "react";

export function SignInModalC({ open, error, onClose }: {
  open: boolean;
  error: string | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="Sign in with GitHub">
      {error && <p role="alert">{error}</p>}
      <p>Flow C · Sign in is being built.</p>
      <button type="button" onClick={onClose}>Close</button>
    </div>
  );
}
