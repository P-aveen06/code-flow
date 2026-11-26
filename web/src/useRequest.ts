import { useEffect, useState } from "react";

type RequestState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; message: string };

export function useRequest<T>(request: (signal: AbortSignal) => Promise<T>): RequestState<T> {
  const [result, setResult] = useState<{ request: typeof request; state: RequestState<T> }>();

  useEffect(() => {
    const controller = new AbortController();
    request(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setResult({ request, state: { status: "ready", data } });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "Something went wrong.";
        setResult({ request, state: { status: "error", message } });
      },
    );
    return () => controller.abort();
  }, [request]);

  return result?.request === request ? result.state : { status: "loading" };
}
