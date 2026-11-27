"""Check CLI help and exercise the installed commands on fixture repositories."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

from codeflow import __version__
from codeflow.analyze import load_commits, load_index
from codeflow.cli import main


def test_version(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exit_info:
        main(["--version"])

    assert exit_info.value.code == 0
    assert capsys.readouterr().out.strip() == __version__


def test_no_arguments_prints_help(capsys: pytest.CaptureFixture[str]) -> None:
    assert main([]) == 0

    output = capsys.readouterr().out
    assert "usage: code-flow" in output
    assert "git for code flow" in output
    assert "--version" in output


def code_flow(*args: str | Path) -> subprocess.CompletedProcess[str]:
    executable = Path(sys.executable).with_name("code-flow")
    return subprocess.run(
        [str(executable), *map(str, args)], check=False, capture_output=True, text=True
    )


def test_workflow_cli(workflow_repo, tmp_path):
    out = tmp_path / "output"
    analyze = code_flow("analyze", workflow_repo.path, "--out", out)
    assert analyze.returncode == 0, analyze.stderr
    commits = load_commits(out)
    lines = analyze.stdout.splitlines()
    assert len(lines) == 4
    assert [line.split()[0] for line in lines[:3]] == [commit.sha[:7] for commit in commits]
    first, guarded, refactored = commits
    assert lines[1] == f"{guarded.sha[:7]} +2 −0 ~1 {guarded.message}"
    assert lines[-1].startswith("Total: 3 commits")

    summary = code_flow(
        "diff", out, "--base", first.sha[:7], "--head", guarded.sha, "--format", "summary"
    )
    assert summary.returncode == 0, summary.stderr
    assert "`run` now routes to `process_fast` behind flag `fast_path`" in summary.stdout

    default_diff = code_flow("diff", out, "--head", guarded.sha[:7])
    assert default_diff.returncode == 0, default_diff.stderr
    assert json.loads(default_diff.stdout)["base"] == first.sha

    root_diff = code_flow("diff", out, "--head", commits[0].sha)
    assert root_diff.returncode == 0, root_diff.stderr
    assert json.loads(root_diff.stdout)["stats"]["nodes_added"] == 3

    mermaid = code_flow("diff", out, "--head", guarded.sha, "--format", "mermaid", "--hops", "0")
    assert mermaid.returncode == 0, mermaid.stderr
    assert mermaid.stdout.startswith("flowchart LR\n")
    assert 'n_workflow_jobs_process_fast["process_fast"]' in mermaid.stdout
    assert "class n_workflow_jobs_process_fast added" in mermaid.stdout
    assert '|"fast_path: on"|' in mermaid.stdout

    flags = code_flow("flags", out, "--commit", guarded.sha[:7])
    assert flags.returncode == 0, flags.stderr
    assert "fast_path\n  workflow/api.py:" in flags.stdout
    assert "tiered_rate\n  workflow/rates.py:" in flags.stdout
    assert "workflow.api:run -> workflow.jobs:process_fast (on)" in flags.stdout
    assert "workflow.api:run -> workflow.jobs:process_standard (off)" in flags.stdout

    flags_json = code_flow("flags", out, "--commit", guarded.sha, "--format", "json")
    assert flags_json.returncode == 0, flags_json.stderr
    report = json.loads(flags_json.stdout)
    assert [check["name"] for check in report["flags"]] == ["fast_path", "tiered_rate"]
    assert report["guarded_edges"]["fast_path"] == [
        {"source": "workflow.api:run", "target": "workflow.jobs:process_fast", "when": "on"},
        {"source": "workflow.api:run", "target": "workflow.jobs:process_standard", "when": "off"},
    ]

    refactor = code_flow("diff", out, "--head", refactored.sha)
    assert refactor.returncode == 0, refactor.stderr
    assert json.loads(refactor.stdout)["nodes"]["removed"] == ["workflow.jobs:process"]

    bad_ref = code_flow("diff", out, "--head", "unknown")
    assert bad_ref.returncode == 2
    assert not bad_ref.stdout
    assert "Unknown commit SHA or prefix: 'unknown'" in bad_ref.stderr
    assert "Traceback" not in bad_ref.stderr


def test_missing_directory_and_non_git_repo_report_errors(tmp_path):
    missing = tmp_path / "missing"
    out = tmp_path / "output"
    for args, message in [
        (("analyze", missing, "--out", out), "Repository directory does not exist"),
        (("analyze", tmp_path, "--out", out), "Not a Git repository"),
        (("flags", missing, "--commit", "abcdef"), "commits.json"),
    ]:
        result = code_flow(*args)
        assert result.returncode == 2
        assert not result.stdout
        assert message in result.stderr
        assert "Traceback" not in result.stderr


def test_analyze_options_and_capped_parent(make_repo, tmp_path):
    repo = make_repo(
        [
            {"src/main.py": "def run(): pass\n"},
            {
                "src/main.py": "import requests\ndef run(): requests.get('/')\n",
                "src/skip.py": "def skip(): pass\n",
                "src/test_main.py": "def test_main(): pass\n",
                "src/other.py": "def other(): pass\n",
                "main.py": "def outside(): pass\n",
            },
        ]
    )
    out = tmp_path / "output"
    result = code_flow(
        "analyze",
        repo.path,
        "--out",
        out,
        "--branch",
        "main",
        "--max-commits",
        "1",
        "--include",
        "**/main.py",
        "**/test_main.py",
        "--include",
        "**/skip.py",
        "--exclude",
        "**/skip.py",
        "**/test_*.py",
        "--source-root",
        "src",
        "--keep-external",
    )
    assert result.returncode == 0, result.stderr
    (commit,) = load_commits(out)
    assert result.stdout.splitlines()[-1] == "Total: 1 commit, +1 −0 ~1"
    head = commit.sha
    snapshot = json.loads((out / "snapshots" / f"{head}.json").read_text())
    assert [node["id"] for node in snapshot["nodes"]] == ["external:requests", "main:run"]

    diff = code_flow("diff", out, "--head", head)
    assert diff.returncode == 0, diff.stderr
    report = json.loads(diff.stdout)
    assert report["base"] == commit.parents[0]
    assert report["nodes"] == {
        "added": ["external:requests"],
        "removed": [],
        "changed": ["main:run"],
    }


def test_touching_uses_indexed_bases_for_counts_and_diff(make_repo, tmp_path):
    repo = make_repo(
        [
            {"src/main.py": "def initial(): pass\n"},
            {"notes.md": "first"},
            {"src/main.py": "def second(): pass\n"},
            {"notes.md": "second"},
            {"src/main.py": "def second(): pass\ndef third(): pass\n"},
            {"notes.md": "latest"},
        ]
    )
    out = tmp_path / "output"
    analysis = code_flow(
        "analyze",
        repo.path,
        "--out",
        out,
        "--source-root",
        "src",
        "--touching",
        "src",
        "--max-commits",
        "2",
    )
    assert analysis.returncode == 0, analysis.stderr
    first, second = load_index(out)["commits"]
    assert analysis.stdout.splitlines() == [
        f"{first['sha'][:7]} +1 −1 ~0 Commit 3",
        f"{second['sha'][:7]} +1 −0 ~0 Commit 5",
        "Total: 2 commits, +2 −1 ~0",
    ]
    assert first["base"] == repo.git("rev-parse", "HEAD~4") == first["parents"][0]
    assert second["base"] == first["sha"] != second["parents"][0]
    for commit in (first, second):
        diff = code_flow("diff", out, "--head", commit["sha"])
        assert diff.returncode == 0, diff.stderr
        assert json.loads(diff.stdout)["base"] == commit["base"]
