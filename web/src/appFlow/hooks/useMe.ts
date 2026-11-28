import { useCallback, useState } from "react";
import { fetchMe, signOut as endSession } from "../../api";
import { useRequest } from "../../useRequest";

// The visitor's GitHub sign-in as GET /api/me reports it. Every sign-in piece reads it here,
// so each one shows the same account after a sign-in or a sign-out.
export function useMe() {
  const [revision, setRevision] = useState(0);
  const loadMe = useCallback((signal: AbortSignal) => fetchMe(signal), [revision]);
  const me = useRequest(loadMe);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  // Ends the session, then reads /api/me again even when the sign-out request failed.
  async function signOut() {
    try {
      await endSession();
    } finally {
      refresh();
    }
  }

  return { me, refresh, signOut };
}
