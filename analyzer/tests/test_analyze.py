"""Exercise the snapshot pipeline, its parse cache, and its readers."""

import json
from dataclasses import asdict
from unittest.mock import Mock

import pytest

from codeflow import analyze
from codeflow.analyze import analyze_repo, load_commits, load_index, load_snapshot, resolve_sha
from codeflow.graph import Commit, Guard


def test_snapshots_are_incremental_and_deterministic(make_repo, tmp_path, monkeypatch):
    shared_source = "def total():\n    return 25\n"
    repo = make_repo(
        [
            {"cart.py": shared_source, "catalog.py": shared_source},
            {"api.py": "from cart import total\n\ndef checkout():\n    return total()\n"},
        ]
    )
    spy = Mock(wraps=analyze.parse_file)
    monkeypatch.setattr(analyze, "parse_file", spy)
    monkeypatch.chdir(tmp_path)
    out = tmp_path / "output"

    first, second = analyze_repo(repo.path.name, out)

    assert [call.args[0] for call in spy.call_args_list] == ["cart.py", "catalog.py", "api.py"]
    assert {path.name for path in (out / "snapshots").iterdir()} == {
        f"{result.commit.sha}.json" for result in (first, second)
    }
    assert [node.id for node in load_snapshot(out, first.commit.sha).nodes] == [
        "cart:total",
        "catalog:total",
    ]
    assert [node.id for node in load_snapshot(out, second.commit.sha).nodes] == [
        "api:checkout",
        "cart:total",
        "catalog:total",
    ]
    assert (first.node_count, first.edge_count, first.flag_count) == (2, 0, 0)
    assert (second.node_count, second.edge_count, second.flag_count) == (3, 1, 0)
    assert first.written and second.written
    assert load_commits(out) == [first.commit, second.commit]
    assert load_index(out) == {
        "schema": "code-flow/commits@1",
        "repo": "repo",
        "repo_path": str(repo.path.resolve()),
        "branch": "HEAD",
        "source_root": "",
        "commits": [
            {**asdict(first.commit), "base": ""},
            {**asdict(second.commit), "base": first.commit.sha},
        ],
    }

    first_bytes = first.snapshot_path.read_bytes()
    second_bytes = second.snapshot_path.read_bytes()
    assert (
        second_bytes.decode()
        == json.dumps(json.loads(second_bytes), indent=2, sort_keys=True) + "\n"
    )

    cached = analyze_repo(repo.path, out)
    assert cached == [
        analyze.CommitResult(first.commit, first.snapshot_path, 2, 0, 0, False, ""),
        analyze.CommitResult(second.commit, second.snapshot_path, 3, 1, 0, False, first.commit.sha),
    ]
    assert spy.call_count == 3

    fresh = analyze_repo(repo.path, tmp_path / "fresh-output")
    assert [result.snapshot_path.read_bytes() for result in fresh] == [first_bytes, second_bytes]


def test_snapshot_keeps_flag_guards_through_elif_chain(make_repo, tmp_path):
    repo = make_repo(
        [
            {
                "api.py": """
def checkout():
    if not is_feature_enabled("new_checkout"):
        return legacy()
    elif expedited:
        return rush()
    else:
        return standard()

def legacy(): pass
def rush(): pass
def standard(): pass
"""
            }
        ]
    )
    out = tmp_path / "output"
    (result,) = analyze_repo(repo.path, out)

    graph = load_snapshot(out, result.commit.sha)
    assert {edge.target: edge.guard for edge in graph.edges} == {
        "api:legacy": Guard("new_checkout", "off"),
        "api:rush": Guard("new_checkout", "on"),
        "api:standard": Guard("new_checkout", "on"),
    }


def test_snapshot_detects_openfeature_calls_and_guards(make_repo, tmp_path):
    repo = make_repo(
        [
            {
                "api.py": """\
def checkout(ctx, name):
    client = get_openfeature_client()
    enabled = client.get_boolean_value(default_value=False, flag_key="local")
    client.get_string_value(name, default_value="fallback")
    client.get_boolean_value(flag_key=name, default_value=False)
    if get_openfeature_client().get_boolean_value(
        "chained", default_value=False, evaluation_context=ctx
    ):
        return chained()
    elif not enabled:
        return disabled()
    elif client.get_boolean_details(flag_key="details", default_value=False):
        return details()
    else:
        return fallback()

def chained(): pass
def disabled(): pass
def details(): pass
def fallback(): pass
"""
            }
        ]
    )
    out = tmp_path / "output"
    (result,) = analyze_repo(repo.path, out)
    graph = load_snapshot(out, result.commit.sha)

    assert [(flag.name, flag.file, flag.line, flag.call) for flag in graph.flags] == [
        ("chained", "api.py", 6, "get_boolean_value"),
        ("details", "api.py", 12, "get_boolean_details"),
        ("local", "api.py", 3, "get_boolean_value"),
    ]
    assert {edge.target: edge.guard for edge in graph.edges} == {
        "api:chained": Guard("chained", "on"),
        "api:disabled": Guard("local", "off"),
        "api:details": Guard("details", "on"),
        "api:fallback": Guard("details", "off"),
    }


def test_progress_precedes_each_listed_snapshot_including_cached_ones(make_repo, tmp_path):
    repo = make_repo([{"first.py": ""}, {"second.py": ""}, {"third.py": ""}])
    out = tmp_path / "output"
    progress = []

    def on_progress(current, total, commit):
        already_exists = (out / "snapshots" / f"{commit.sha}.json").exists()
        progress.append((current, total, commit, already_exists))

    first, second = analyze_repo(repo.path, out, max_commits=2, on_progress=on_progress)
    assert progress == [(1, 2, first.commit, False), (2, 2, second.commit, False)]

    progress.clear()
    analyze_repo(repo.path, out, max_commits=2, on_progress=on_progress)
    assert progress == [(1, 2, first.commit, True), (2, 2, second.commit, True)]


def test_capped_history_writes_and_backfills_unlisted_parent(make_repo, tmp_path):
    repo = make_repo(
        [{"api.py": "def old(): pass\n"}, {"api.py": "def new(): pass\n"}, {"notes.md": "Notes"}]
    )
    out = tmp_path / "output"

    (head,) = analyze_repo(repo.path, out, max_commits=1)
    (base_sha,) = head.commit.parents
    base = load_snapshot(out, base_sha)
    assert [node.id for node in base.nodes] == ["api:new"]
    assert load_commits(out) == [head.commit]
    assert len(list((out / "snapshots").glob("*.json"))) == 2

    (out / "snapshots" / f"{base_sha}.json").unlink()
    (cached_head,) = analyze_repo(repo.path, out, max_commits=1)
    assert not cached_head.written
    assert load_snapshot(out, base_sha) == base


def test_shallow_history_gets_a_base_when_the_parent_becomes_available(make_repo, tmp_path):
    repo = make_repo([{"api.py": "def old(): pass\n"}, {"api.py": "def new(): pass\n"}])
    shallow = tmp_path / "shallow"
    repo.git("clone", "--quiet", "--depth=1", "--no-local", str(repo.path), str(shallow))
    out = tmp_path / "output"

    (head,) = analyze_repo(shallow, out, max_commits=1)
    assert load_index(out)["commits"][0]["base"] == ""
    assert load_snapshot(out, head.commit.sha).commit.parents == []
    assert list((out / "snapshots").glob("*.json")) == [head.snapshot_path]

    repo.git("-C", str(shallow), "fetch", "--quiet", "--deepen=1", "origin")
    (updated,) = analyze_repo(shallow, out, max_commits=1)
    base_sha = repo.git("rev-parse", "HEAD^")
    assert load_index(out)["commits"][0]["base"] == base_sha
    assert updated.commit.sha == head.commit.sha
    assert load_snapshot(out, updated.commit.sha).commit.parents == [base_sha]
    assert [node.id for node in load_snapshot(out, base_sha).nodes] == ["api:old"]
    assert load_commits(out) == [updated.commit]


def test_source_root_selection_and_options(make_repo, tmp_path):
    repo = make_repo(
        [
            {"outside.py": "def outside(): pass\n", "src/shop/catalog.py": "def item(): pass\n"},
            {"src/shop/test_cart.py": "import requests\n\ndef cart():\n    requests.get('/')\n"},
        ]
    )
    out = tmp_path / "output"

    (result,) = analyze_repo(
        repo.path,
        out,
        branch="main",
        max_commits=1,
        source_root="src",
        include=("**/*.py",),
        exclude=(),
        keep_external=True,
    )

    assert [node.id for node in load_snapshot(out, result.commit.sha).nodes] == [
        "external:requests",
        "shop.catalog:item",
        "shop.test_cart:cart",
    ]
    assert result.commit.message == "Commit 2"
    index = json.loads((out / "commits.json").read_text(encoding="utf-8"))
    assert index["branch"] == "main"
    assert index["source_root"] == "src"


def test_undecodable_blobs_are_skipped_in_each_snapshot(make_repo, tmp_path):
    repo = make_repo(
        [
            {"broken.py": b"# invalid UTF-8: \xff\n", "cart.py": "def total(): pass\n"},
            {"api.py": "def checkout(): pass\n"},
            {"broken.py": "def fixed(): pass\n"},
        ]
    )

    first, second, third = analyze_repo(repo.path, tmp_path / "output")

    assert [result.skipped for result in (first, second, third)] == [
        ["broken.py"],
        ["broken.py"],
        [],
    ]
    assert [result.node_count for result in (first, second, third)] == [1, 2, 3]


def test_parser_recursion_failure_is_local_to_one_file(make_repo, tmp_path, monkeypatch):
    repo = make_repo([{"deep.py": "", "cart.py": "def total(): pass\n"}])
    parse_file = analyze.parse_file

    def parse(path: str, source: bytes, source_root: str):
        if path == "deep.py":
            raise RecursionError("expression exceeds parser depth")
        return parse_file(path, source, source_root)

    monkeypatch.setattr(analyze, "parse_file", parse)

    (result,) = analyze_repo(repo.path, tmp_path / "output")

    assert result.skipped == ["deep.py"]
    assert result.node_count == 1


def test_resolve_sha_uses_the_current_index(make_repo, tmp_path):
    repo = make_repo([{"cart.py": ""}, {"api.py": ""}])
    out = tmp_path / "output"
    first, second = analyze_repo(repo.path, out)
    assert resolve_sha(out, first.commit.sha) == first.commit.sha
    assert resolve_sha(out, second.commit.sha[:12]) == second.commit.sha
    assert not analyze_repo(repo.path, out, max_commits=1)[0].written
    with pytest.raises(ValueError, match="Unknown commit SHA or prefix"):
        resolve_sha(out, first.commit.sha)


def test_resolve_sha_rejects_ambiguous_prefix(tmp_path):
    shas = ["ab" + "0" * 38, "ab" + "1" * 38]
    commits = [asdict(Commit(sha, [], "Author", "2026-11-20T09:00:00Z", "Subject")) for sha in shas]
    (tmp_path / "commits.json").write_text(json.dumps({"commits": commits}), encoding="utf-8")

    assert resolve_sha(tmp_path, "ab0") == shas[0]
    with pytest.raises(ValueError, match="Ambiguous commit SHA prefix: 'ab'"):
        resolve_sha(tmp_path, "ab")
