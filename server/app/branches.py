"""List the branches of an imported GitHub repository, read their commits, and import one.

A branch import repeats the source of the import it started from, on another branch, and keeps
its owner. Public repositories are read without a token, or with CODEFLOW_GITHUB_API_TOKEN once
the import is published. Private repositories are read with the app installation that clones them.
"""

from collections.abc import Callable, Iterable
from dataclasses import asdict
from typing import TypeVar

from app.github import GitHubApp, GitHubAuthError, GitHubCommit, GitHubError, GitHubRest
from app.import_analysis import ImportSource
from app.importer import GITHUB_URL, RepoImporter, source_from_metadata, validate_branch
from app.store import BadRequest, Store

MAX_LISTED_BRANCHES = 100
# The stored fields a branch import keeps from the import it started from.
KEPT_FIELDS = ("url", "subdir", "visibility", "owner_uid", "installation_id", "github_repo_id")
T = TypeVar("T")


class BranchesUnavailable(ValueError):
    """Only repositories imported from GitHub have branches to switch between."""


def github_full_name(metadata: dict) -> str:
    """The owner and name of the GitHub repository that an import came from."""
    url = metadata.get("url")
    match = GITHUB_URL.fullmatch(url) if isinstance(url, str) else None
    if match is None:
        raise BranchesUnavailable(
            "Only repositories imported from GitHub have branches to switch between"
        )
    owner, name = match.groups()
    return f"{owner}/{name}"


def import_settings(store: Store, importer: RepoImporter, repo: str) -> dict:
    """An import's stored settings and status: its job while one runs or failed, else its source."""
    job = importer.job(repo)
    if job is not None:
        return {**asdict(job.source), "status": job.status}
    with store.lock:
        return {**store.repo_source(repo), "status": "ready"}


def known_imports(store: Store, importer: RepoImporter) -> dict[str, dict]:
    """Every import the server knows, keyed by ID: published ones, then running or failed jobs."""
    with store.lock:
        imports = {repo: {**source, "status": "ready"} for repo, source in store.sources().items()}
        for job in importer.jobs():
            imports[job.source.id] = {**asdict(job.source), "status": job.status}
    return imports


def branch_listing(
    repo: str, metadata: dict, default: str, names: Iterable[str], imports: dict[str, dict]
) -> dict:
    """The response to GET /branches: the branches on GitHub and the imports already made."""
    return {
        "repo": repo,
        "full_name": github_full_name(metadata),
        "default_branch": default,
        "current_branch": metadata.get("branch") or default,
        "branches": ordered_branches(names, default),
        "analyzed": analyzed_imports(imports, metadata, default),
    }


def ordered_branches(names: Iterable[str], default: str) -> list[str]:
    """The default branch first, then the rest by name, at most MAX_LISTED_BRANCHES."""
    ordered = sorted(set(names), key=lambda name: (name != default, name.lower()))
    return ordered[:MAX_LISTED_BRANCHES]


def analyzed_imports(imports: dict[str, dict], metadata: dict, default: str) -> list[dict]:
    """The imports of this repository and folder that the same viewers may see."""
    return [
        {"branch": item.get("branch") or default, "id": repo, "status": item["status"]}
        for repo, item in sorted(imports.items())
        if same_repository_and_folder(item, metadata)
    ]


def same_repository_and_folder(item: dict, metadata: dict) -> bool:
    """Match the GitHub repository (names ignore case) and folder. Public imports match public
    ones; a private import matches only the imports of its owner."""
    url = item.get("url")
    if not isinstance(url, str) or url.lower() != metadata["url"].lower():
        return False
    if item.get("subdir", "") != metadata.get("subdir", ""):
        return False
    if metadata.get("visibility") == "private":
        return item.get("visibility") == "private" and item.get("owner_uid") == metadata.get(
            "owner_uid"
        )
    return item.get("visibility", "public") != "private"


def branch_source(metadata: dict, body: object, default: str, *, limit: int) -> ImportSource:
    """The import of another branch of this repository and folder, owned as the original is."""
    if not isinstance(body, dict):
        raise BadRequest("Import request must be a JSON object")
    branch = validate_branch(body.get("branch"))
    kept = {key: metadata[key] for key in KEPT_FIELDS if key in metadata}
    # The default branch keeps the plain ID, so it matches the import of the same repository.
    return source_from_metadata(
        {
            **kept,
            "branch": "" if branch == default else branch,
            "max_commits": body.get("max_commits"),
        },
        limit=limit,
    )


class ImportedBranches:
    """Ask GitHub about an imported repository with the token that its import may use."""

    def __init__(self, rest: GitHubRest, app: GitHubApp | None, api_token: str | None) -> None:
        self._rest = rest
        self._app = app
        self._api_token = api_token

    def default_branch(self, metadata: dict) -> str:
        full_name, token = github_full_name(metadata), self._token(metadata)
        return self._call(lambda: self._rest.default_branch(token, full_name))

    def listing(self, metadata: dict) -> tuple[str, list[str]]:
        """The default branch, and the name of every branch on GitHub."""
        full_name, token = github_full_name(metadata), self._token(metadata)
        return self._call(
            lambda: (
                self._rest.default_branch(token, full_name),
                self._rest.branches(token, full_name),
            )
        )

    def commits(self, metadata: dict, branch: str, limit: int) -> tuple[str, list[GitHubCommit]]:
        """The latest commits of a branch. An empty branch name means the default branch."""
        full_name, token = github_full_name(metadata), self._token(metadata)

        def fetch() -> tuple[str, list[GitHubCommit]]:
            name = branch or self._rest.default_branch(token, full_name)
            return name, self._rest.commits(token, full_name, name, limit)

        return self._call(fetch)

    def _token(self, metadata: dict) -> str | None:
        """Private imports use their installation. Public ones use the optional API token only
        once published, so a clone that failed (say, of a private URL) never sends it."""
        if metadata.get("visibility") == "private":
            installation_id, repo_id = (
                metadata.get("installation_id"),
                metadata.get("github_repo_id"),
            )
            if self._app is None or installation_id is None or repo_id is None:
                raise GitHubError("GitHub sign-in is not set up on this server")
            return self._app.installation_token(installation_id, repo_id)
        return self._api_token if metadata.get("status") == "ready" else None

    @staticmethod
    def _call(call: Callable[[], T]) -> T:
        """A token that GitHub refuses is this server's problem, not a reason to sign in again."""
        try:
            return call()
        except GitHubAuthError as exc:
            raise GitHubError(
                "GitHub did not accept this server's access to the repository"
            ) from exc
