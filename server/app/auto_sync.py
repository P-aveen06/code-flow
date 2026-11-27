"""Persist auto-sync settings and schedule refreshes on the import worker."""

import json
import logging
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event, Lock, Thread
from time import monotonic

from app.importer import RefreshBusy, RefreshStats, RefreshUnavailable, RepoImporter
from app.store import BadRequest, NotFound

SCHEMA = "code-flow/auto-sync@1"
logger = logging.getLogger(__name__)


def parse_update(payload: object) -> tuple[bool | None, dict[str, bool]]:
    if (
        not isinstance(payload, dict)
        or payload.keys() - {"all", "repos"}
        or ("all" in payload and type(payload["all"]) is not bool)
    ):
        raise BadRequest(
            "Auto-sync settings must be an object with optional 'all' and 'repos' fields"
        )
    repos = payload.get("repos", {})
    if not isinstance(repos, dict) or any(type(value) is not bool for value in repos.values()):
        raise BadRequest("Auto-sync 'repos' must map repository IDs to booleans")
    return payload.get("all"), repos


@dataclass(frozen=True)
class SyncSettings:
    all: bool = False
    repos: dict[str, bool] = field(default_factory=dict)

    def enabled(self, repo_id: str) -> bool:
        return self.all or self.repos.get(repo_id, False)


class AutoSync:
    def __init__(
        self, importer: RepoImporter, interval: float, *, clock: Callable[[], float] = monotonic
    ) -> None:
        self.importer = importer
        self.interval = interval
        self._clock = clock
        self._path = importer.store.data_dir / "auto_sync.json"
        self._settings = SyncSettings()
        self._next_runs: dict[str, float] = {}
        self._lock = Lock()
        self._wake = Event()
        self._stop = Event()
        self._thread: Thread | None = None

    def _load(self) -> SyncSettings:
        try:
            payload = json.loads(self._path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict) or payload.pop("schema", None) != SCHEMA:
                return SyncSettings()
            all_repos, repos = parse_update(payload)
            if all_repos is not None and "repos" in payload:
                return SyncSettings(all_repos, repos)
        except (OSError, ValueError):
            pass
        return SyncSettings()

    def start(self) -> None:
        self._settings = self._load()
        self._next_runs.clear()
        self._stop.clear()
        self._thread = Thread(target=self._run, name="code-flow-auto-sync")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread is not None:
            self._thread.join()

    def response(self) -> dict:
        with self._lock:
            return self._response()

    def _response(self) -> dict:
        status = self.importer.refresh_stats()
        now = datetime.now(UTC)
        clock = self._clock()
        for repo_id in status.keys() | self._next_runs.keys():
            if repo_id not in status:
                status[repo_id] = asdict(RefreshStats())
            deadline = self._next_runs.get(repo_id)
            status[repo_id]["next_run"] = (
                (now + timedelta(seconds=max(0, deadline - clock))).isoformat()
                if deadline is not None
                else None
            )
        return {"interval_seconds": self.interval, **asdict(self._settings), "status": status}

    def update(self, payload: object) -> dict:
        all_repos, repos = parse_update(payload)
        with self._lock:
            with self.importer.store.lock:
                for repo_id in repos:
                    self.importer.github_source(repo_id)
            previous = self._settings
            updated = SyncSettings(
                previous.all if all_repos is None else all_repos, {**previous.repos, **repos}
            )
            if updated != previous:
                self._path.parent.mkdir(parents=True, exist_ok=True)
                with TemporaryDirectory(dir=self._path.parent) as directory:
                    staged = Path(directory) / self._path.name
                    staged.write_text(
                        json.dumps({"schema": SCHEMA, **asdict(updated)}, indent=2) + "\n",
                        encoding="utf-8",
                    )
                    staged.replace(self._path)
                self._settings = updated
                self._next_runs = {
                    repo_id: deadline
                    for repo_id, deadline in self._next_runs.items()
                    if updated.enabled(repo_id)
                }
                self._wake.set()
            return self._response()

    def _run(self) -> None:
        while True:
            self._wake.clear()
            if self._stop.is_set():
                return
            try:
                self.tick()
            except Exception:
                logger.exception("Could not check for scheduled repository refreshes")
            self._wake.wait(min(1.0, self.interval))

    def tick(self) -> None:
        with self._lock:
            if self._settings.all:
                with self.importer.store.lock:
                    repo_ids = self.importer.store.source_repo_ids()
            else:
                repo_ids = [repo_id for repo_id, enabled in self._settings.repos.items() if enabled]
            for repo_id in repo_ids:
                if self._stop.is_set():
                    break
                now = self._clock()
                if now < self._next_runs.get(repo_id, now):
                    continue
                try:
                    self.importer.refresh(repo_id, automatic=True)
                except RefreshBusy:
                    # Give newly enabled repos their first check as soon as the worker is free.
                    if repo_id not in self._next_runs:
                        continue
                except (NotFound, RefreshUnavailable):
                    self._next_runs.pop(repo_id, None)
                    continue
                except BadRequest as exc:
                    self.importer.record_auto_error(repo_id, str(exc))
                except Exception:  # noqa: BLE001
                    self.importer.record_auto_error(
                        repo_id, "Could not schedule repository refresh"
                    )
                self._next_runs[repo_id] = now + self.interval
