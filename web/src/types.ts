export interface Repo {
  name: string;
  branch: string;
  commit_count: number;
}

export interface Commit {
  sha: string;
  parents: string[];
  author: string;
  date: string;
  message: string;
}

export interface DiffStats {
  nodes_added: number;
  nodes_removed: number;
  nodes_changed: number;
  edges_added: number;
  edges_removed: number;
}

export interface TimelineCommit extends Commit {
  stats: DiffStats;
  summary: string;
}

export interface CommitList {
  repo: string;
  branch: string;
  commits: TimelineCommit[];
}

export type NodeKind = "function" | "method" | "class" | "module" | "external";

export interface Guard {
  flag: string;
  when: "on" | "off";
}

interface EdgeEndpoints {
  source: string;
  target: string;
}

interface NodeLocation {
  id: string;
  name: string;
  module: string;
  kind: NodeKind;
  file: string;
  line: number;
  end_line: number;
}

export interface GraphSnapshot {
  schema: "code-flow/graph@1";
  repo: string;
  commit: Commit;
  nodes: (NodeLocation & { body_hash: string })[];
  edges: (EdgeEndpoints & { kind: "call"; line: number; guard: Guard | null })[];
  flags: { name: string; file: string; line: number; function: string; call: string }[];
}

interface AddedRemoved<T> {
  added: T[];
  removed: T[];
}

export interface GraphDiff {
  schema: "code-flow/diff@1";
  base: string;
  head: string;
  nodes: AddedRemoved<string> & { changed: string[] };
  edges: AddedRemoved<EdgeEndpoints>;
  flags: AddedRemoved<string>;
  stats: DiffStats;
}

export type EdgeStatus = "added" | "removed" | "context";
export type NodeStatus = EdgeStatus | "changed";

interface RevisionPresence {
  in_base: boolean;
  in_head: boolean;
}

export interface OverlayNode extends NodeLocation, RevisionPresence {
  qualname: string;
  status: NodeStatus;
}

export interface OverlayEdge extends EdgeEndpoints, RevisionPresence {
  status: EdgeStatus;
  guard: Guard | null;
}

export interface DiffViewModel {
  base: string;
  head: string;
  summary: string;
  diff: GraphDiff;
  nodes: OverlayNode[];
  edges: OverlayEdge[];
}

export interface CodeSnippet {
  sha: string;
  file: string;
  start: number;
  end: number;
  lines: { number: number; text: string }[];
}
