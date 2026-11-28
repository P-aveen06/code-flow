// One switch per screen: today's page, or the flow's version of it, chosen by that screen's piece.
import { useEffect } from "react";
import type { ComponentType } from "react";
import { AppLink } from "../AppLink";
import { GitHubRepoPage } from "../pages/GitHubRepo";
import { GitHubRepos } from "../pages/GitHubRepos";
import { Landing } from "../pages/Landing";
import { Viewer } from "../pages/Viewer";
import { githubReposPath, navigate } from "../router";
import { usePiece } from "./AppFlowProvider";
import { markBranchSwitchOpened } from "./journey";
import { BranchSwitchA } from "./flows/a/BranchSwitch";
import { BranchSwitchB } from "./flows/b/BranchSwitch";
import { BranchSwitchC } from "./flows/c/BranchSwitch";
import { FlowViewA } from "./flows/a/FlowView";
import { FlowViewB } from "./flows/b/FlowView";
import { FlowViewC } from "./flows/c/FlowView";
import { LandingA } from "./flows/a/Landing";
import { LandingB } from "./flows/b/Landing";
import { LandingC } from "./flows/c/Landing";
import { RepoDetailsA } from "./flows/a/RepoDetails";
import { RepoDetailsB } from "./flows/b/RepoDetails";
import { RepoDetailsC } from "./flows/c/RepoDetails";
import { ReposA } from "./flows/a/Repos";
import { ReposB } from "./flows/b/Repos";
import { ReposC } from "./flows/c/Repos";
import { SignInPageA } from "./flows/a/SignIn";
import type { Piece } from "./types";

type ReposProps = { search: string };
type RepoDetailsProps = { repoId: number; search: string };
type FlowViewProps = { id: string; search: string };
type BranchSwitchProps = { repoId: string; currentBranch: string };

const landingScreens: Record<Piece, ComponentType> = {
  today: Landing, a: LandingA, b: LandingB, c: LandingC,
};

export function LandingScreen() {
  const Screen = landingScreens[usePiece("landing_layout")];
  return <Screen />;
}

// /signin exists only for flow A. Other pieces send the visitor back to the landing page.
export function SignInScreen() {
  const leave = usePiece("signin_layout") !== "a";
  useEffect(() => {
    if (leave) navigate("/", { replace: true });
  }, [leave]);
  return leave ? null : <SignInPageA />;
}

const reposScreens: Record<Piece, ComponentType<ReposProps>> = {
  today: GitHubRepos, a: ReposA, b: ReposB, c: ReposC,
};

export function ReposScreen({ search }: ReposProps) {
  const Screen = reposScreens[usePiece("repos_layout")];
  return <Screen search={search} />;
}

const repoDetailsScreens: Record<Piece, ComponentType<RepoDetailsProps>> = {
  today: GitHubRepoPage, a: RepoDetailsA, b: RepoDetailsB, c: RepoDetailsC,
};

export function RepoDetailsScreen({ repoId, search }: RepoDetailsProps) {
  const Screen = repoDetailsScreens[usePiece("repo_details_layout")];
  return <Screen key={repoId} repoId={repoId} search={search} />;
}

const flowViewScreens: Record<Piece, ComponentType<FlowViewProps>> = {
  today: Viewer, a: FlowViewA, b: FlowViewB, c: FlowViewC,
};

export function FlowViewScreen({ id, search }: FlowViewProps) {
  const Screen = flowViewScreens[usePiece("flow_view_layout")];
  return <Screen key={id} id={id} search={search} />;
}

// Today has no branch switch inside the flow view. This link reaches the repo picker instead,
// and opening it starts the branch switch's clock like the flows' own switches do.
function TodayBranchLink() {
  return <AppLink href={githubReposPath} onClick={() => markBranchSwitchOpened()}>Switch branch</AppLink>;
}

const branchSwitchScreens: Record<Piece, ComponentType<BranchSwitchProps>> = {
  today: TodayBranchLink, a: BranchSwitchA, b: BranchSwitchB, c: BranchSwitchC,
};

export function BranchSwitchScreen({ repoId, currentBranch }: BranchSwitchProps) {
  const Screen = branchSwitchScreens[usePiece("branch_switch")];
  return <Screen repoId={repoId} currentBranch={currentBranch} />;
}
