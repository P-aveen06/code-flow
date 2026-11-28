import { useEffect } from "react";
import { AppLink } from "./AppLink";
import { AppFlowProvider, useAppFlow } from "./appFlow/AppFlowProvider";
import { FlowViewScreen, LandingScreen, RepoDetailsScreen, ReposScreen, SignInScreen } from "./appFlow/screens";
import type { Switch } from "./appFlow/types";
import { legacyRepoRedirect, navigate, parsePath, useLocation } from "./router";
import type { Route } from "./router";

export default function App() {
  const { pathname, search, hash } = useLocation();
  const route = parsePath(pathname);
  const redirect = legacyRepoRedirect(pathname, search);

  useEffect(() => {
    if (redirect) navigate(redirect + hash, { replace: true });
  }, [redirect, hash]);

  return (
    <AppFlowProvider search={search}>
      <Pages route={route} redirect={redirect} search={search} />
    </AppFlowProvider>
  );
}

// The page's switch decides whether today's top bar shows. Flow screens draw their own header.
const topbarSwitch: Record<Route["page"], Switch | null> = {
  landing: "landing_layout",
  signin: "landing_layout",
  "github-repos": "repos_layout",
  "github-repo": "repo_details_layout",
  viewer: "flow_view_layout",
  "not-found": null,
};

function Pages({ route, redirect, search }: { route: Route; redirect: string | null; search: string }) {
  const { ready, pieces } = useAppFlow();
  if (!ready) return <div className="app" aria-busy="true" />;

  const switchName = topbarSwitch[route.page];
  const showTopbar = switchName === null || pieces[switchName] === "today";

  return (
    <div className="app">
      {showTopbar && (
        <header className="topbar">
          <AppLink href="/" className="topbar__brand">
            <span className="topbar__brand-mark" aria-hidden="true">↳</span>
            <strong>code-flow</strong>
          </AppLink>
        </header>
      )}
      {route.page === "landing" && !redirect && <LandingScreen />}
      {route.page === "signin" && <SignInScreen />}
      {route.page === "github-repos" && <ReposScreen search={search} />}
      {route.page === "github-repo" && <RepoDetailsScreen key={route.repoId} repoId={route.repoId} search={search} />}
      {route.page === "viewer" && <FlowViewScreen key={route.id} id={route.id} search={search} />}
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
