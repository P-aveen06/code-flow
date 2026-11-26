"""Reserve live reviewer runs before sending events, including across processes."""

import sqlite3
from contextlib import closing
from pathlib import Path


def reserve_reviewers(path: Path, flag: str, identities: set[str], *, allow_repeat: bool) -> int:
    """Return the overlap and reserve the selection if the run can proceed."""
    if not identities:
        return 0
    try:
        with closing(sqlite3.connect(path)) as database, database:
            database.execute("BEGIN IMMEDIATE")
            database.execute(
                """
                CREATE TABLE IF NOT EXISTS reviewer_runs (
                    flag TEXT NOT NULL,
                    identity TEXT NOT NULL,
                    PRIMARY KEY (flag, identity)
                )
                """
            )
            recorded = {
                identity
                for (identity,) in database.execute(
                    "SELECT identity FROM reviewer_runs WHERE flag = ?", (flag,)
                )
            }
            repeated = len(identities & recorded)
            if not repeated or allow_repeat:
                database.executemany(
                    "INSERT OR IGNORE INTO reviewer_runs (flag, identity) VALUES (?, ?)",
                    ((flag, identity) for identity in identities),
                )
            return repeated
    except sqlite3.Error as exc:
        raise ValueError(
            f"Could not check the local simulator run history at {path}: {exc}"
        ) from exc
