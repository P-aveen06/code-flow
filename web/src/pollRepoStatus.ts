import { fetchRepoStatus } from "./api";
import type { ImportStatus } from "./types";

function waitForNextPoll(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 1000);
    function abort() {
      window.clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function pollRepoStatus(
  id: string, signal: AbortSignal, onUpdate: (status: ImportStatus) => void,
): Promise<ImportStatus> {
  for (;;) {
    await waitForNextPoll(signal);
    signal.throwIfAborted();
    const status = await fetchRepoStatus(id, signal);
    signal.throwIfAborted();
    onUpdate(status);
    if (status.status === "ready" || status.status === "error") return status;
  }
}
