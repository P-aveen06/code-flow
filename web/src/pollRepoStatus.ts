import { fetchRepoStatus } from "./api";
import type { ImportStatus } from "./types";
import { waitFor } from "./waitFor";

export async function pollRepoStatus(
  id: string, signal: AbortSignal, onUpdate: (status: ImportStatus) => void,
): Promise<ImportStatus> {
  for (;;) {
    await waitFor(1000, signal);
    signal.throwIfAborted();
    const status = await fetchRepoStatus(id, signal);
    signal.throwIfAborted();
    onUpdate(status);
    if (status.status === "ready" || status.status === "error") return status;
  }
}
