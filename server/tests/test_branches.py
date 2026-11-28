"""Branches of imported GitHub repositories: listing, commits, and starting a branch import."""

import hashlib
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient
from test_importer import InlineExecutor, commit, git, local_repo  # noqa: F401 (fixture)
from test_signin import CLONE_TOKEN, CSRF, ORIGIN, PRIVATE, PRIVATE_ID, FakeGitHub, sign_in

from app.branches import analyzed_imports, ordered_branches
from app.config import Settings
from app.github import GitHubRest
from app.main import create_app

URL = "https://github.com/Demo/shop"
REPOS = "/api/repos"
PUBLIC_ID = "Demo__shop"


class FakeGitHubApi:
    """Answers GitHub's REST paths for any Owner/name repository, and records each request."""

    def __init__(self) -> None:
        self.names = ["feature/cart", "Docs", "main"]
        self.status = 200
        self.authorizations: list[str | None] = []

    def __call__(self, method: str, url: str, headers: dict, body: bytes | None):
        self.authorizations.append(headers.get("Authorization"))
        if self.status != 200:
            return self.status, None
        parts = urlsplit(url)
        resource = parts.path.split("/")[4:]
        if not resource:
            return 200, {"default_branch": "main"}
        if resource == ["branches"]:
            return 200, [{"name": name} for name in self.names]
        if resource == ["commits"]:
            return 200, fake_commits(parse_qs(parts.query)["sha"][0])
        raise AssertionError(f"Unexpected GitHub call: {url}")


def fake_commits(branch: str, count: int = 5) -> list[dict]:
    """A first-parent chain of commits, newest first, the way GitHub lists them."""
    shas = [hashlib.sha1(f"{branch}:{n}".encode()).hexdigest() for n in range(count)]
    return [
        {
            "sha": sha,
            "html_url": f"https://github.com/Demo/shop/commit/{sha}",
            "author": {"login": "dev"},
            "commit": {
                "message": f"{branch} change {n}\n\nDetails",
                "author": {"name": "Dev", "date": "2026-11-27T10:00:00Z"},
            },
            "parents": [{"sha": shas[n + 1]}] if n + 1 < count else [],
        }
        for n, sha in enumerate(shas)
    ]


def add_feature_branch(repo: Path) -> None:
    git(repo, "checkout", "--quiet", "-b", "feature/cart")
    commit(repo, "shop/cart.py", "def cart(): return []\n", "Empty cart")
    git(repo, "checkout", "--quiet", "main")


@pytest.fixture
def github_api() -> FakeGitHubApi:
    return FakeGitHubApi()


def make_app(
    tmp_path: Path,
    local_repo: Path,  # noqa: F811
    github_api: FakeGitHubApi,
    *,
    settings: Settings | None = None,
    git_url_builder=None,
):
    settings = settings or Settings(tmp_path / "data", ORIGIN, max_private_imports=2)
    return create_app(
        settings,
        git_url_builder=git_url_builder or (lambda _: local_repo.as_uri()),
        executor=InlineExecutor(),
        github_app=FakeGitHub(),
        github_rest=GitHubRest(github_api),
    )


@pytest.fixture
def app(tmp_path: Path, local_repo: Path, github_api: FakeGitHubApi):  # noqa: F811
    return make_app(tmp_path, local_repo, github_api)


def import_public(client: TestClient, **body) -> None:
    response = client.post(REPOS, json={"url": URL, "max_commits": 2, **body}, headers=CSRF)
    assert response.status_code == 202


def test_public_branches_are_listed_without_a_token(app, github_api: FakeGitHubApi):
    with TestClient(app) as client:
        import_public(client)
        response = client.get(f"{REPOS}/{PUBLIC_ID}/branches")

    assert response.status_code == 200
    assert response.json() == {
        "repo": PUBLIC_ID,
        "full_name": "Demo/shop",
        "default_branch": "main",
        "current_branch": "main",
        "branches": ["main", "Docs", "feature/cart"],
        "analyzed": [{"branch": "main", "id": PUBLIC_ID, "status": "ready"}],
    }
    assert github_api.authorizations == [None, None]


def test_api_token_is_sent_only_for_published_public_imports(
    tmp_path: Path,
    local_repo: Path,  # noqa: F811
    github_api: FakeGitHubApi,
):
    settings = Settings(tmp_path / "data", ORIGIN, github_api_token="api-token")

    def clone_only_shop(url: str) -> str:
        # The import of any other URL fails to clone, like a private repository would.
        return local_repo.as_uri() if url == URL else (tmp_path / "missing").as_uri()

    app = make_app(
        tmp_path, local_repo, github_api, settings=settings, git_url_builder=clone_only_shop
    )
    with TestClient(app) as client:
        import_public(client)
        assert client.get(f"{REPOS}/{PUBLIC_ID}/branches").status_code == 200
        assert github_api.authorizations[-1] == "Bearer api-token"

        broken = "https://github.com/Demo/broken"
        queued = client.post(REPOS, json={"url": broken, "max_commits": 2}, headers=CSRF)
        assert queued.status_code == 202
        failed = client.get(f"{REPOS}/Demo__broken/branches")
        assert failed.status_code == 200
        assert failed.json()["analyzed"] == [
            {"branch": "main", "id": "Demo__broken", "status": "error"}
        ]
        # A failed import never sends the token, so it cannot expose a private repository.
        assert github_api.authorizations[-2:] == [None, None]


def test_branch_commits_have_the_github_commit_shape(app, local_repo: Path):  # noqa: F811
    add_feature_branch(local_repo)
    with TestClient(app) as client:
        import_public(client)
        response = client.get(
            f"{REPOS}/{PUBLIC_ID}/branches/commits", params={"branch": "feature/cart", "limit": 2}
        )
        default = client.get(f"{REPOS}/{PUBLIC_ID}/branches/commits", params={"limit": 500})
        too_small = client.get(f"{REPOS}/{PUBLIC_ID}/branches/commits", params={"limit": 0})
        bad_branch = client.get(f"{REPOS}/{PUBLIC_ID}/branches/commits", params={"branch": "../x"})

    assert response.status_code == 200
    body = response.json()
    assert (body["branch"], body["limit"]) == ("feature/cart", 2)
    assert [commit["message"] for commit in body["commits"]] == [
        "feature/cart change 0",
        "feature/cart change 1",
    ]
    assert set(body["commits"][0]) == {"sha", "message", "author", "date", "url"}
    assert body["commits"][0]["author"] == "dev"
    # An empty branch is the default branch, and the import cap bounds the count.
    assert (default.json()["branch"], default.json()["limit"]) == ("main", 200)
    assert too_small.status_code == 422
    assert bad_branch.status_code == 400


def test_branch_imports_keep_the_plain_id_for_the_default_branch(
    app,
    local_repo: Path,  # noqa: F811
):
    add_feature_branch(local_repo)
    with TestClient(app) as client:
        import_public(client)
        branch = client.post(
            f"{REPOS}/{PUBLIC_ID}/branches",
            json={"branch": "feature/cart", "max_commits": 2},
            headers=CSRF,
        )
        assert branch.status_code == 202
        assert branch.json() == {"id": "Demo__shop@feature~cart", "status": "queued"}

        # The import of the branch lists the default branch's import as its sibling.
        listing = client.get(f"{REPOS}/Demo__shop@feature~cart/branches").json()
        assert listing["current_branch"] == "feature/cart"
        assert listing["analyzed"] == [
            {"branch": "main", "id": PUBLIC_ID, "status": "ready"},
            {"branch": "feature/cart", "id": "Demo__shop@feature~cart", "status": "ready"},
        ]

        default = client.post(
            f"{REPOS}/Demo__shop@feature~cart/branches",
            json={"branch": "main", "max_commits": 2},
            headers=CSRF,
        )
        assert default.json() == {"id": PUBLIC_ID, "status": "queued"}


def test_branch_imports_validate_the_request(app):
    with TestClient(app) as client:
        import_public(client)
        url = f"{REPOS}/{PUBLIC_ID}/branches"
        cases = [
            ({"branch": "-x", "max_commits": 2}, 400, "Pick a branch from the list"),
            ({"branch": "feature/cart", "max_commits": 201}, 400, "from 1 to 200"),
            ({"branch": "feature/cart"}, 400, "from 1 to 200"),
            ([], 400, "must be a JSON object"),
        ]
        for body, status, message in cases:
            response = client.post(url, json=body, headers=CSRF)
            assert response.status_code == status, body
            assert message in response.json()["detail"]
        invalid = client.post(
            url, content=b"{", headers={**CSRF, "Content-Type": "application/json"}
        )
        assert invalid.status_code == 400
        assert invalid.json() == {"detail": "Import request must be valid JSON"}


def test_github_failures_become_bad_gateway(app, github_api: FakeGitHubApi):
    with TestClient(app) as client:
        import_public(client)
        github_api.status = 500
        failed = client.get(f"{REPOS}/{PUBLIC_ID}/branches")
        assert failed.status_code == 502
        assert failed.json() == {"detail": "Could not read this repository on GitHub"}

        github_api.status = 401
        refused = client.get(f"{REPOS}/{PUBLIC_ID}/branches/commits", params={"branch": "main"})
        assert refused.status_code == 502
        assert "sign in" not in refused.json()["detail"].lower()


def test_imports_outside_github_have_no_branches(fixture_data: Path, github_api: FakeGitHubApi):
    with TestClient(
        create_app(Settings(fixture_data, ORIGIN), github_rest=GitHubRest(github_api))
    ) as client:
        response = client.get("/api/repos/review-fixture/branches")
        assert response.status_code == 409
        assert "Only repositories imported from GitHub" in response.json()["detail"]
        assert client.get("/api/repos/missing/branches").status_code == 404


def test_private_branches_use_the_installation_and_stay_with_the_owner(
    tmp_path: Path,
    local_repo: Path,  # noqa: F811
    github_api: FakeGitHubApi,
):
    add_feature_branch(local_repo)
    app = make_app(tmp_path, local_repo, github_api)
    with TestClient(app) as owner:
        sign_in(owner, "1")
        assert owner.post(REPOS, json=PRIVATE, headers=CSRF).status_code == 202
        listing = owner.get(f"{REPOS}/{PRIVATE_ID}/branches")
        assert listing.status_code == 200
        assert listing.json()["branches"] == ["main", "Docs", "feature/cart"]
        assert github_api.authorizations[-1] == f"Bearer {CLONE_TOKEN}"

        branch = owner.post(
            f"{REPOS}/{PRIVATE_ID}/branches",
            json={"branch": "feature/cart", "max_commits": 2},
            headers=CSRF,
        )
        assert branch.json() == {"id": "p_1__Demo__shop@feature~cart", "status": "queued"}
        commits = owner.get(
            f"{REPOS}/p_1__Demo__shop@feature~cart/branches/commits", params={"branch": "main"}
        )
        assert commits.status_code == 200
        assert commits.json()["commits"][0]["message"] == "main change 0"

        stranger, anonymous = TestClient(app), TestClient(app)
        sign_in(stranger, "2")
        requests = [
            ("GET", f"{REPOS}/{PRIVATE_ID}/branches", None),
            ("GET", f"{REPOS}/{PRIVATE_ID}/branches/commits", None),
            ("POST", f"{REPOS}/{PRIVATE_ID}/branches", {"branch": "Docs", "max_commits": 2}),
        ]
        for client in (stranger, anonymous):
            for method, path, body in requests:
                response = client.request(method, path, json=body, headers=CSRF)
                assert response.status_code == 404, path
                assert response.json() == {"detail": f"Unknown repository: {PRIVATE_ID!r}"}


def test_private_branch_imports_respect_the_cap(
    tmp_path: Path,
    local_repo: Path,  # noqa: F811
    github_api,
):
    add_feature_branch(local_repo)
    settings = Settings(tmp_path / "data", ORIGIN, max_private_imports=1)
    app = make_app(tmp_path, local_repo, github_api, settings=settings)
    with TestClient(app) as owner:
        sign_in(owner, "1")
        assert owner.post(REPOS, json=PRIVATE, headers=CSRF).status_code == 202
        capped = owner.post(
            f"{REPOS}/{PRIVATE_ID}/branches",
            json={"branch": "feature/cart", "max_commits": 2},
            headers=CSRF,
        )
        assert capped.status_code == 409
        assert "up to 1 private" in capped.json()["detail"]
        # Re-analyzing the counted import itself is not a new one.
        again = owner.post(
            f"{REPOS}/{PRIVATE_ID}/branches",
            json={"branch": "main", "max_commits": 2},
            headers=CSRF,
        )
        assert again.json() == {"id": PRIVATE_ID, "status": "queued"}


def test_branch_order_puts_the_default_first_and_caps_the_list():
    names = [f"b{n:03}" for n in range(150)] + ["Zeta", "alpha"]
    ordered = ordered_branches(names, "Zeta")
    assert ordered[0] == "Zeta"
    assert ordered[1] == "alpha"
    assert len(ordered) == 100


def test_analyzed_imports_match_the_repository_folder_and_audience():
    private = {"url": URL, "subdir": "", "visibility": "private", "owner_uid": 1, "status": "ready"}
    public = {"url": URL.lower(), "subdir": "", "visibility": "public", "status": "analyzing"}
    imports = {
        "p_1__Demo__shop": {**private, "branch": ""},
        "p_1__Demo__shop@dev": {**private, "branch": "dev"},
        "p_2__Demo__shop": {**private, "owner_uid": 2},
        "Demo__shop@dev": {**public, "branch": "dev"},
        "Demo__shop-api": {**public, "subdir": "api"},
    }
    owner_view = analyzed_imports(imports, private, "main")
    assert owner_view == [
        {"branch": "main", "id": "p_1__Demo__shop", "status": "ready"},
        {"branch": "dev", "id": "p_1__Demo__shop@dev", "status": "ready"},
    ]
    assert analyzed_imports(imports, public, "main") == [
        {"branch": "dev", "id": "Demo__shop@dev", "status": "analyzing"},
    ]
