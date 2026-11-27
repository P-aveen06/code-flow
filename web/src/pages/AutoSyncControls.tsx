import { useId } from "react";
import type { AutoSyncStatus } from "../types";

export function AutoSyncSwitch({ repoName, checked, disabled, error, onChange }: {
  repoName?: string;
  checked: boolean;
  disabled: boolean;
  error?: string;
  onChange: (checked: boolean) => void;
}) {
  const errorId = useId();
  const label = repoName ? "Auto-sync" : "Auto-sync all repos";
  return (
    <div className="auto-sync-control">
      <button type="button" role="switch" aria-checked={checked} aria-disabled={disabled}
        aria-label={repoName ? `Auto-sync for ${repoName}` : label}
        aria-describedby={error ? errorId : undefined}
        className="auto-sync-switch" onClick={() => { if (!disabled) onChange(!checked); }}>
        <span className="auto-sync-switch__track" aria-hidden="true" />
        {label}
      </button>
      {error && <p className="muted" id={errorId} role="alert">{error}</p>}
    </div>
  );
}

export function autoSyncStatusText(status: AutoSyncStatus | undefined, enabled: boolean, now = Date.now()) {
  if (status?.last_started && (!status.last_finished || status.last_started > status.last_finished)) {
    return "Syncing…";
  }
  if (status?.last_result === "error") return status.error ?? "Auto-sync failed";
  if (!status?.last_finished) return enabled ? "Waiting to sync…" : "Auto-sync is off";
  const minutes = Math.floor((now - Date.parse(status.last_finished)) / 60_000);
  if (minutes < 1) return "Synced just now";
  if (minutes < 60) return `Synced ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `Synced ${hours} hr ago` : `Synced ${Math.floor(hours / 24)} d ago`;
}
