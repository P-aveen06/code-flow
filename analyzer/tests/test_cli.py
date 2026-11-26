"""Check CLI help and exercise the installed commands on fixture repositories."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

from codeflow import __version__
from codeflow.analyze import load_commits
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


def test_demo_cli(make_shop_demo, tmp_path):
    repo, _ = make_shop_demo()
    out = tmp_path / "output"
    analyze = code_flow("analyze", repo, "--out", out)
    assert analyze.returncode == 0, analyze.stderr
    commits = load_commits(out)
    lines = analyze.stdout.splitlines()
    assert len(lines) == 9
    assert [line.split()[0] for line in lines[:8]] == [commit.sha[:7] for commit in commits]
    c4, c5 = commits[3:5]
    assert lines[4] == f"{c5.sha[:7]} +2 −0 ~1 {c5.message}"
    assert lines[-1].startswith("Total: 8 commits")

    summary = code_flow("diff", out, "--base", c4.sha[:7], "--head", c5.sha, "--format", "summary")
    assert summary.returncode == 0, summary.stderr
    assert "`checkout` now routes to `new_checkout` behind flag `new_checkout`" in summary.stdout

    default_diff = code_flow("diff", out, "--head", c5.sha[:7])
    assert default_diff.returncode == 0, default_diff.stderr
    assert json.loads(default_diff.stdout)["base"] == c4.sha

    root_diff = code_flow("diff", out, "--head", commits[0].sha)
    assert root_diff.returncode == 0, root_diff.stderr
    assert json.loads(root_diff.stdout)["stats"]["nodes_added"] == 5

    mermaid = code_flow("diff", out, "--head", c5.sha, "--format", "mermaid", "--hops", "0")
    assert mermaid.returncode == 0, mermaid.stderr
    assert mermaid.stdout.startswith("flowchart LR\n")
    assert 'n_shop_checkout_new_checkout["new_checkout"]' in mermaid.stdout
    assert "class n_shop_checkout_new_checkout added" in mermaid.stdout
    assert '|"new_checkout: on"|' in mermaid.stdout

    flags = code_flow("flags", out, "--commit", c5.sha[:7])
    assert flags.returncode == 0, flags.stderr
    assert "new_checkout\n  shop/api.py:" in flags.stdout
    assert "holiday_discount\n  shop/cart.py:" in flags.stdout
    assert "shop.api:checkout -> shop.checkout:new_checkout (on)" in flags.stdout
    assert "shop.api:checkout -> shop.checkout:legacy_checkout (off)" in flags.stdout

    flags_json = code_flow("flags", out, "--commit", c5.sha, "--format", "json")
    assert flags_json.returncode == 0, flags_json.stderr
    report = json.loads(flags_json.stdout)
    assert [check["name"] for check in report["flags"]] == ["holiday_discount", "new_checkout"]
    assert report["guarded_edges"]["new_checkout"] == [
        {"source": "shop.api:checkout", "target": "shop.checkout:legacy_checkout", "when": "off"},
        {"source": "shop.api:checkout", "target": "shop.checkout:new_checkout", "when": "on"},
    ]

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


def test_analyze_options_and_missing_parent(make_repo, tmp_path):
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
    assert result.stdout.splitlines()[-1] == "Total: 1 commit, +2 −0 ~0"
    head = commit.sha
    snapshot = json.loads((out / "snapshots" / f"{head}.json").read_text())
    assert [node["id"] for node in snapshot["nodes"]] == ["external:requests", "main:run"]

    missing_parent = code_flow("diff", out, "--head", head)
    assert missing_parent.returncode == 2
    assert f"No snapshot for first parent {commit.parents[0]}" in missing_parent.stderr
    assert "Traceback" not in missing_parent.stderr
