"""Reserve live reviewer runs before sending events, including across processes."""

import sqlite3
from contextlib import closing
from pathlib import Path

from config import PRODUCTION_ENVIRONMENT


def _prepare_history(database: sqlite3.Connection) -> None:
    columns = {row[1] for row in database.execute("PRAGMA table_info(reviewer_runs)")}
    legacy = columns and "environment" not in columns
    if legacy:
        database.execute("ALTER TABLE reviewer_runs RENAME TO legacy_reviewer_runs")
    database.execute(
        """
        CREATE TABLE IF NOT EXISTS reviewer_runs (
            environment TEXT NOT NULL,
            flag TEXT NOT NULL,
            identity TEXT NOT NULL,
            PRIMARY KEY (environment, flag, identity)
        )
        """
    )
    if legacy:
        database.execute(
            "INSERT INTO reviewer_runs (environment, flag, identity) "
            "SELECT ?, flag, identity FROM legacy_reviewer_runs",
            (PRODUCTION_ENVIRONMENT,),
        )
        database.execute("DROP TABLE legacy_reviewer_runs")


def reserve_reviewers(
    path: Path, environment: str, flag: str, identities: set[str], *, allow_repeat: bool
) -> int:
    """Return the overlap and reserve the selection if the run can proceed."""
    if not identities:
        return 0
    try:
        with closing(sqlite3.connect(path)) as database, database:
            database.execute("BEGIN IMMEDIATE")
            _prepare_history(database)
            recorded = {
                identity
                for (identity,) in database.execute(
                    "SELECT identity FROM reviewer_runs WHERE environment = ? AND flag = ?",
                    (environment, flag),
                )
            }
            repeated = len(identities & recorded)
            if not repeated or allow_repeat:
                database.executemany(
                    "INSERT OR IGNORE INTO reviewer_runs (environment, flag, identity) "
                    "VALUES (?, ?, ?)",
                    ((environment, flag, identity) for identity in identities),
                )
            return repeated
    except sqlite3.Error as exc:
        raise ValueError(
            f"Could not check the local simulator run history at {path}: {exc}"
        ) from exc
