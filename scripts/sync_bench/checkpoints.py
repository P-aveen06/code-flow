"""Store completed cases and identify reusable benchmark inputs."""

import fcntl
import json
import os
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from tempfile import NamedTemporaryFile

from sync_bench.suspension import SAMPLE_GAP_LIMIT_S

Case = tuple[str, str, int]


def _digest(value: dict) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return sha256(encoded.encode()).hexdigest()


def run_key(
    code_flow_sha: str,
    *,
    interval: float,
    intervals: int,
    visits_per_hour: float,
    seed: int,
    flagsmith_sha: str | None,
    quick: bool,
) -> str:
    return _digest(
        {
            "code_flow_sha": code_flow_sha,
            "interval": float(interval),
            "intervals": intervals,
            "visits_per_hour": float(visits_per_hour),
            "seed": seed,
            "flagsmith_sha": flagsmith_sha,
            "quick": quick,
        }
    )[:20]


def template_key(
    size: str, start_sha: str, max_commits: int, code_flow_sha: str
) -> str:
    key = _digest(
        {
            "size": size,
            "start_sha": start_sha,
            "max_commits": max_commits,
            "code_flow_sha": code_flow_sha,
        }
    )
    return f"{size}-{key[:20]}"


def read_record(path: Path) -> dict | None:
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(record, dict) and record.pop("_sha256", None) == _digest(record):
            return record
    except (FileNotFoundError, ValueError):
        pass
    return None


def write_record(path: Path, payload: dict) -> None:
    record = {**payload, "_sha256": _digest(payload)}
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, prefix=".pending-", delete=False
    ) as output:
        temporary = Path(output.name)
        try:
            json.dump(record, output, separators=(",", ":"), allow_nan=False)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
            output.close()
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


@dataclass(frozen=True)
class SavedCase:
    result: dict
    environment: dict
    template: dict
    elapsed_s: float
    finished_at_utc: str


class CaseStore:
    def __init__(self, workdir: Path, key: str) -> None:
        self.key = key
        self.directory = workdir / "results" / key
        if self.directory.parent.is_symlink() or self.directory.is_symlink():
            raise ValueError("Benchmark results must be inside the workdir.")

    def path(self, case: Case) -> Path:
        variant, size, count = case
        return self.directory / f"{variant}-{size}-{count}.json"

    def save(self, case: Case, saved: SavedCase) -> None:
        write_record(
            self.path(case),
            {
                **saved.result,
                "_checkpoint": {
                    "run_key": self.key,
                    "environment": saved.environment,
                    "template": saved.template,
                    "elapsed_s": saved.elapsed_s,
                    "finished_at_utc": saved.finished_at_utc,
                },
            },
        )

    def load(self, case: Case) -> SavedCase | None:
        path = self.path(case)
        if path.is_symlink():
            return None
        result = read_record(path)
        if result is None:
            return None
        try:
            metadata = result.pop("_checkpoint")
            if (
                metadata.pop("run_key") == self.key
                and (result["variant"], result["size"], result["repo_count"]) == case
                and result["suspended"] is False
                and 0 <= result["max_sample_gap_s"] <= SAMPLE_GAP_LIMIT_S
            ):
                return SavedCase(result, **metadata)
        except (AttributeError, TypeError, KeyError):
            pass
        return None


@contextmanager
def lock_workdir(workdir: Path) -> Iterator[None]:
    path = workdir / ".sync-benchmark.lock"
    if path.is_symlink():
        raise ValueError("The benchmark lock must be inside the workdir.")
    with path.open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("A benchmark is already using this workdir.") from None
        yield
