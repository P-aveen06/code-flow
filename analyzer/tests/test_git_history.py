"""Check first-parent history and blob access against real Git repositories."""

import pytest

from codeflow.git_history import (
    GitHistoryError,
    batch_blobs,
    list_commits,
    list_python_files,
    read_blob,
)
from codeflow.graph import Commit


def test_first_parent_commits_and_max_count(make_repo):
    repo = make_repo([{"cart.py": "def total(): pass\n"}])
    first = repo.git("rev-parse", "HEAD")
    repo.git("switch", "-c", "side")
    side = repo.commit({"side.py": "def extra(): pass\n"})
    repo.git("switch", "main")
    second = repo.commit({"api.py": "def checkout(): pass\n"})
    repo.git("merge", "--no-ff", "-m", "Merge café checkout changes\n\nMore detail", "side")
    merge = repo.git("rev-parse", "HEAD")

    commits = list_commits(repo.path, "main")

    assert commits == [
        Commit(first, [], "Fixture Author", "2026-11-20T03:30:00Z", "Commit 1"),
        Commit(second, [first], "Fixture Author", "2026-11-20T05:30:00Z", "Commit 3"),
        Commit(
            merge,
            [second, side],
            "Fixture Author",
            "2026-11-20T06:30:00Z",
            "Merge café checkout changes",
        ),
    ]
    assert list_commits(repo.path, max_count=2) == commits[-2:]
    assert list_commits(repo.path, max_count=0) == []
    assert [commit.sha for commit in list_commits(repo.path, "side")] == [first, side]


def test_python_filters_and_blob_bytes(make_repo):
    repo = make_repo(
        [
            {
                "root.py": b"# original\r\n",
                "tests/helper.py": "",
                "nested/tests/helper.py": "",
                "test_root.py": "",
                "nested/root_test.py": "",
                "conftest.py": "",
                "migrations/001_initial.py": "",
                "nested/module.py": "",
                "nested/ignored.py": "",
                "nested/café\tline\nbreak.py": "",
                "typing.pyi": "",
                "README.md": "",
            },
            {"root.py": None},
        ]
    )
    first, second = list_commits(repo.path)
    files = dict(list_python_files(repo.path, first.sha))

    assert files.keys() == {
        "root.py",
        "nested/module.py",
        "nested/ignored.py",
        "nested/café\tline\nbreak.py",
    }
    assert read_blob(repo.path, files["root.py"]) == b"# original\r\n"
    assert "root.py" not in dict(list_python_files(repo.path, second.sha))
    assert dict(
        list_python_files(
            repo.path,
            first.sha,
            include=("**/test_*.py", "**/nested/*.py", "**/*.pyi"),
            exclude=("**/ignored.py", "**/tests/**"),
        )
    ).keys() == {
        "test_root.py",
        "nested/root_test.py",
        "nested/module.py",
        "nested/café\tline\nbreak.py",
        "typing.pyi",
    }


def test_repository_and_branch_errors(make_repo, tmp_path):
    with pytest.raises(GitHistoryError, match="Not a Git repository"):
        list_commits(tmp_path)

    repo = make_repo([{"cart.py": ""}])
    with pytest.raises(GitHistoryError, match="Unknown Git branch or ref 'missing'"):
        list_commits(repo.path, "missing")


def test_batch_reader_keeps_blob_boundaries(make_repo):
    repo = make_repo([{"data.py": b"\x00\xff\r\n", "empty.py": b"", "text.py": b"no newline"}])
    head = repo.git("rev-parse", "HEAD")
    files = dict(list_python_files(repo.path, "HEAD"))

    with batch_blobs(repo.path) as read:
        assert read(files["data.py"]) == b"\x00\xff\r\n"
        assert read(files["empty.py"]) == b""
        with pytest.raises(GitHistoryError, match="Cannot read Git blob"):
            read("0" * 40)
        with pytest.raises(GitHistoryError, match="is not a blob"):
            read(head)
        assert read(files["text.py"]) == b"no newline"
