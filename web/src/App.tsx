import { useEffect } from "react";
import { AppLink } from "./AppLink";
import { Landing } from "./pages/Landing";
import { Viewer } from "./pages/Viewer";
import { legacyRepoRedirect, navigate, parsePath, useLocation } from "./router";

export default function App() {
  const { pathname, search, hash } = useLocation();
  const route = parsePath(pathname);
  const redirect = legacyRepoRedirect(pathname, search);

  useEffect(() => {
    if (redirect) navigate(redirect + hash, { replace: true });
  }, [redirect, hash]);

  return (
    <div className="app">
      <header className="topbar">
        <AppLink href="/" className="topbar__brand">
          <span className="topbar__brand-mark" aria-hidden="true">↳</span>
          <strong>code-flow</strong>
        </AppLink>
      </header>
      {route.page === "viewer" && <Viewer key={route.id} id={route.id} search={search} />}
      {route.page === "landing" && !redirect && <Landing search={search} />}
      {route.page === "not-found" && (
        <main className="app-message">
          <div className="message-stack">
            <h1>Not found</h1>
            <AppLink href="/">Back to code-flow</AppLink>
          </div>
        </main>
      )}
    </div>
  );
}
