"""Provide the code-flow command-line entry point."""

import argparse
import json
import sys
from collections import defaultdict
from dataclasses import asdict
from pathlib import Path

from codeflow import __version__
from codeflow.analyze import (
    analyze_repo,
    diff_base,
    load_index,
    load_snapshot,
    resolve_commit,
    resolve_sha,
)
from codeflow.diff import diff_graphs
from codeflow.export_mermaid import to_mermaid
from codeflow.git_history import GitHistoryError
from codeflow.graph import FlagCheck, Graph
from codeflow.summary import summarize


def _analyze(args: argparse.Namespace) -> None:
    if not args.repo.is_dir():
        raise ValueError(f"Repository directory does not exist: {args.repo}")
    results = analyze_repo(
        args.repo,
        args.out,
        branch=args.branch,
        max_commits=args.max_commits,
        include=args.include,
        exclude=args.exclude,
        source_root=args.source_root,
        keep_external=args.keep_external,
        touching=args.touching,
    )
    previous = None
    total_added = total_removed = total_changed = 0
    for result in results:
        commit = result.commit
        head = load_snapshot(args.out, commit.sha)
        base = (
            previous
            if previous and previous.commit.sha == result.base
            else _base_graph(args.out, head, result.base)
        )
        nodes = diff_graphs(base, head).nodes
        added, removed, changed = len(nodes.added), len(nodes.removed), len(nodes.changed)
        print(f"{commit.sha[:7]} +{added} −{removed} ~{changed} {commit.message}")
        total_added += added
        total_removed += removed
        total_changed += changed
        previous = head

    noun = "commit" if len(results) == 1 else "commits"
    print(f"Total: {len(results)} {noun}, +{total_added} −{total_removed} ~{total_changed}")


def _load_graph(directory: Path, ref: str) -> Graph:
    return load_snapshot(directory, resolve_sha(directory, ref))


def _base_graph(directory: Path, head: Graph, sha: str) -> Graph:
    if not sha:
        return head.empty_base()
    try:
        return load_snapshot(directory, sha)
    except FileNotFoundError as exc:
        raise ValueError(f"No snapshot for diff base {sha}. Analyze it or pass --base.") from exc


def _diff(args: argparse.Namespace) -> None:
    index = load_index(args.dir)
    entry = resolve_commit(index, args.head)
    head = load_snapshot(args.dir, entry["sha"])
    base_sha = diff_base(entry) if args.base is None else resolve_commit(index, args.base)["sha"]
    base = _base_graph(args.dir, head, base_sha)
    diff = diff_graphs(base, head)
    if args.format == "mermaid":
        print(to_mermaid(base, head, diff, args.hops))
    elif args.format == "summary":
        print(summarize(base, head, diff))
    else:
        print(json.dumps(diff.to_json(), indent=2))


def _flags(args: argparse.Namespace) -> None:
    graph = _load_graph(args.dir, args.commit)
    checks = sorted(
        graph.flags,
        key=lambda check: (check.name, check.file, check.line, check.function, check.call),
    )
    guarded_edges: dict[str, list[dict[str, str]]] = {check.name: [] for check in checks}
    for edge in sorted(graph.edges, key=lambda edge: (edge.source, edge.target)):
        if edge.guard:
            guarded_edges.setdefault(edge.guard.flag, []).append(
                {"source": edge.source, "target": edge.target, "when": edge.guard.when}
            )

    if args.format == "json":
        print(
            json.dumps(
                {"flags": [asdict(check) for check in checks], "guarded_edges": guarded_edges},
                indent=2,
            )
        )
        return

    if not guarded_edges:
        print("No flag checks")
        return
    checks_by_name: dict[str, list[FlagCheck]] = defaultdict(list)
    for check in checks:
        checks_by_name[check.name].append(check)
    for name in sorted(guarded_edges):
        print(name)
        for check in checks_by_name[name]:
            print(f"  {check.file}:{check.line} {check.function}")
        for edge in guarded_edges[name]:
            print(f"  {edge['source']} -> {edge['target']} ({edge['when']})")


def _nonnegative_int(value: str) -> int:
    number = int(value)
    if number < 0:
        raise argparse.ArgumentTypeError("must be non-negative")
    return number


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="code-flow", description="git for code flow")
    parser.add_argument("--version", action="version", version=__version__)
    commands = parser.add_subparsers(dest="command")

    analyze_parser = commands.add_parser("analyze", help="Write snapshots for a Git repository")
    analyze_parser.add_argument("repo", type=Path)
    analyze_parser.add_argument("--out", type=Path, required=True)
    analyze_parser.add_argument("--branch", default="HEAD")
    analyze_parser.add_argument("--max-commits", type=_nonnegative_int)
    analyze_parser.add_argument("--include", action="extend", nargs="+", metavar="GLOB")
    analyze_parser.add_argument("--exclude", action="extend", nargs="+", metavar="GLOB")
    analyze_parser.add_argument("--source-root", default="", metavar="DIR")
    analyze_parser.add_argument(
        "--touching", metavar="PATH", help="Only list commits changing PATH"
    )
    analyze_parser.add_argument("--keep-external", action="store_true")
    analyze_parser.set_defaults(run=_analyze)

    diff_parser = commands.add_parser("diff", help="Compare two graph snapshots")
    diff_parser.add_argument("dir", type=Path)
    diff_parser.add_argument("--head", required=True, metavar="REF")
    diff_parser.add_argument(
        "--base", metavar="REF", help="Defaults to the head's indexed diff base"
    )
    diff_parser.add_argument("--format", choices=("json", "mermaid", "summary"), default="json")
    diff_parser.add_argument("--hops", type=_nonnegative_int, default=1)
    diff_parser.set_defaults(run=_diff)

    flags_parser = commands.add_parser("flags", help="List flag checks and guarded calls")
    flags_parser.add_argument("dir", type=Path)
    flags_parser.add_argument("--commit", required=True, metavar="REF")
    flags_parser.add_argument("--format", choices=("text", "json"), default="text")
    flags_parser.set_defaults(run=_flags)

    args = parser.parse_args(argv)
    if args.command is None:
        parser.print_help()
        return 0
    try:
        args.run(args)
    except (GitHistoryError, OSError, ValueError) as exc:
        print(f"code-flow: {exc}", file=sys.stderr)
        return 2
    return 0
