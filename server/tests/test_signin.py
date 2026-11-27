"""Sign in with GitHub, private imports, and per-user visibility of every repo route."""

import base64
import json
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from test_importer import InlineExecutor, local_repo  # noqa: F401 (fixture)

from app import import_analysis
from app.config import GitHubAppSettings, Settings
from app.github import (
    GitHubApp,
    GitHubAuthError,
    GitHubError,
    GitHubRepo,
    GitHubUser,
    UserToken,
)
from app.import_analysis import git_auth_env
from app.main import create_app

ORIGIN = "http://example.test"
CSRF = {"X-Requested-With": "code-flow"}
CLONE_TOKEN = "ghs_secret_clone_token"
PRIVATE = {"github_repo_id": 7, "installation_id": 9, "subdir": "shop", "max_commits": 2}
PRIVATE_ID = "p_1__Demo__shop"


class FakeGitHub:
    """Stands in for GitHubApp. Codes "1" and "2" sign in two different users."""

    def __init__(self) -> None:
        self.users = {
            "tok-1": GitHubUser(1, "owner", "https://avatars.test/1"),
            "tok-2": GitHubUser(2, "stranger", "https://avatars.test/2"),
        }
        self.repos = {
            "tok-1": [
                GitHubRepo(7, "Demo/shop", True, "main", 9),
                GitHubRepo(8, "Demo/open", False, "main", 9),
                GitHubRepo(10, "Demo/other", True, "main", 9),
            ],
            "tok-2": [],
        }
        self.expires_at: float | None = None
        self.minted: list[tuple[int, int]] = []
        self.revoked: list[str] = []
        self.refreshed: list[str] = []

    def authorize_url(self, redirect_uri: str, state: str) -> str:
        return f"https://github.test/authorize?state={state}&redirect_uri={redirect_uri}"

    def install_url(self) -> str:
        return "https://github.test/apps/code-flow/installations/new"

    def exchange_code(self, code: str, redirect_uri: str) -> UserToken:
        assert redirect_uri == f"{ORIGIN}/api/auth/github/callback"
        if code == "bad":
            raise GitHubError("GitHub did not accept the sign-in")
        return UserToken(f"tok-{code}", self.expires_at, f"refresh-{code}", None)

    def refresh(self, refresh_token: str) -> UserToken:
        self.refreshed.append(refresh_token)
        return UserToken(refresh_token.replace("refresh-", "tok-"), None, refresh_token, None)

    def user(self, token: str) -> GitHubUser:
        return self.users[token]

    def repositories(self, token: str) -> list[GitHubRepo]:
        return self.repos[token]

    def installation_token(self, installation_id: int, repository_id: int) -> str:
        self.minted.append((installation_id, repository_id))
        return CLONE_TOKEN

    def revoke(self, token: str) -> None:
        self.revoked.append(token)


def sign_in(client: TestClient, code: str) -> None:
    login = client.get("/api/auth/github/login", follow_redirects=False)
    assert login.status_code == 302
    state = parse_qs(urlparse(login.headers["location"]).query)["state"][0]
    callback = client.get(
        "/api/auth/github/callback",
        params={"code": code, "state": state},
        follow_redirects=False,
    )
    assert callback.headers["location"] == f"{ORIGIN}/?signed_in=1"
    cookie = callback.headers["set-cookie"]
    assert "cf_session=" in cookie and "HttpOnly" in cookie and "SameSite=lax" in cookie


@pytest.fixture
def github() -> FakeGitHub:
    return FakeGitHub()


@pytest.fixture
def app(tmp_path: Path, local_repo: Path, github: FakeGitHub):  # noqa: F811
    settings = Settings(tmp_path / "data", ORIGIN, max_private_imports=1)
    return create_app(
        settings,
        git_url_builder=lambda _: local_repo.as_uri(),
        executor=InlineExecutor(),
        github_app=github,
    )


def test_sign_in_me_and_sign_out(app, github: FakeGitHub):
    with TestClient(app) as client:
        assert client.get("/api/me").json() == {"configured": True, "signed_in": False}
        sign_in(client, "1")
        assert client.get("/api/me").json() == {
            "configured": True,
            "signed_in": True,
            "login": "owner",
            "avatar_url": "https://avatars.test/1",
            "install_url": "https://github.test/apps/code-flow/installations/new",
        }
        assert client.post("/api/auth/logout", headers=CSRF).status_code == 204
        assert github.revoked == ["tok-1"]
        assert client.get("/api/me").json()["signed_in"] is False


@pytest.mark.parametrize(
    ("params", "reason"),
    [
        ({"code": "1", "state": "forged"}, "expired"),
        ({"code": "1"}, "expired"),
        ({"error": "access_denied"}, "denied"),
        ({"code": "bad", "state": None}, "github"),
    ],
)
def test_callback_failures_return_to_the_site(app, params: dict, reason: str):
    with TestClient(app) as client:
        login = client.get("/api/auth/github/login", follow_redirects=False)
        if params.get("state", "") is None:
            params["state"] = parse_qs(urlparse(login.headers["location"]).query)["state"][0]
        response = client.get("/api/auth/github/callback", params=params, follow_redirects=False)
        assert response.headers["location"] == f"{ORIGIN}/?signin_error={reason}"
        assert client.get("/api/me").json()["signed_in"] is False


def test_sign_in_routes_are_off_without_an_app(tmp_path: Path):
    with TestClient(create_app(Settings(tmp_path / "data", ORIGIN))) as client:
        assert client.get("/api/me").json() == {"configured": False, "signed_in": False}
        assert client.get("/api/auth/github/login", follow_redirects=False).status_code == 404
        assert client.get("/api/github/repos").status_code == 404


def test_repo_picker_needs_sign_in_and_refreshes_expired_tokens(app, github: FakeGitHub):
    github.expires_at = 0
    with TestClient(app) as client:
        assert client.get("/api/github/repos").status_code == 401
        sign_in(client, "1")
        repos = client.get("/api/github/repos").json()
        assert github.refreshed == ["refresh-1"]
        assert [repo["full_name"] for repo in repos] == ["Demo/shop", "Demo/open", "Demo/other"]
        assert repos[0] == {
            "id": 7,
            "full_name": "Demo/shop",
            "private": True,
            "default_branch": "main",
            "installation_id": 9,
        }


def test_private_import_is_visible_only_to_its_owner(
    app, github: FakeGitHub, tmp_path: Path, monkeypatch
):
    tokens = []

    def record_git(*args, **kwargs):
        tokens.append(kwargs.get("token"))
        return git_command(*args, **kwargs)

    git_command = import_analysis._git
    monkeypatch.setattr(import_analysis, "_git", record_git)
    with TestClient(app) as owner:
        sign_in(owner, "1")
        response = owner.post("/api/repos", json=PRIVATE, headers=CSRF)
        assert response.json() == {"id": PRIVATE_ID, "status": "queued"}
        assert owner.get(f"/api/repos/{PRIVATE_ID}/status").json()["status"] == "ready"
        assert github.minted == [(9, 7)]
        assert CLONE_TOKEN in tokens

        data = tmp_path / "data"
        source = json.loads((data / PRIVATE_ID / "source.json").read_text())
        assert source["visibility"] == "private"
        assert (source["owner_uid"], source["installation_id"], source["github_repo_id"]) == (
            1,
            9,
            7,
        )
        for path in (data / "repos" / PRIVATE_ID / ".git" / "config", data / PRIVATE_ID):
            files = [path] if path.is_file() else path.rglob("*.json")
            assert all(CLONE_TOKEN not in file.read_text() for file in files)

        listing = owner.get("/api/repos").json()
        assert [(repo["id"], repo["visibility"]) for repo in listing] == [(PRIVATE_ID, "private")]
        assert "owner_uid" not in listing[0]
        sha = owner.get(f"/api/repos/{PRIVATE_ID}/commits").json()["commits"][-1]["sha"]
        routes = [
            ("GET", "status", {}),
            ("GET", "commits", {}),
            ("GET", f"snapshots/{sha}", {}),
            ("GET", "flags", {}),
            ("GET", "diff", {"head": sha}),
            ("GET", "function-diff", {"head": sha, "node": "shop/price.py::price"}),
            ("GET", "code", {"sha": sha, "file": "shop/price.py"}),
            ("POST", "refresh", {}),
        ]
        for method, route in [("GET", "commits"), ("GET", "diff"), ("GET", "code")]:
            params = next(p for m, r, p in routes if r == route and m == method)
            assert owner.get(f"/api/repos/{PRIVATE_ID}/{route}", params=params).status_code == 200

        stranger, anonymous = TestClient(app), TestClient(app)
        sign_in(stranger, "2")
        for client in (stranger, anonymous):
            assert client.get("/api/repos").json() == []
            for method, route, params in routes:
                response = client.request(
                    method, f"/api/repos/{PRIVATE_ID}/{route}", params=params, headers=CSRF
                )
                assert response.status_code == 404, (route, response.json())
                assert response.json() == {"detail": f"Unknown repository: {PRIVATE_ID!r}"}

        assert owner.post(f"/api/repos/{PRIVATE_ID}/refresh", headers=CSRF).status_code == 202
        assert github.minted == [(9, 7), (9, 7)]


def test_picked_public_repo_is_shared_and_private_imports_are_capped(app, github: FakeGitHub):
    with TestClient(app) as owner:
        sign_in(owner, "1")
        public = {**PRIVATE, "github_repo_id": 8}
        assert owner.post("/api/repos", json=public, headers=CSRF).json()["id"] == "Demo__open"
        assert owner.post("/api/repos", json=PRIVATE, headers=CSRF).status_code == 202
        other = {**PRIVATE, "github_repo_id": 10}
        capped = owner.post("/api/repos", json=other, headers=CSRF)
        assert capped.status_code == 409
        assert "up to 1 private" in capped.json()["detail"]
        # Re-importing a repo you already own does not count against the cap.
        assert owner.post("/api/repos", json=PRIVATE, headers=CSRF).status_code == 202
        assert github.minted == [(9, 7), (9, 7)]

        anonymous = TestClient(app)
        assert [repo["id"] for repo in anonymous.get("/api/repos").json()] == ["Demo__open"]


def test_picked_repo_must_come_from_the_users_installations(app):
    with TestClient(app) as client:
        assert client.post("/api/repos", json=PRIVATE).status_code == 401
        sign_in(client, "2")
        response = client.post("/api/repos", json=PRIVATE, headers=CSRF)
        assert response.status_code == 404
        bad = client.post("/api/repos", json={**PRIVATE, "github_repo_id": "7"}, headers=CSRF)
        assert bad.status_code == 400


def test_session_posts_need_the_code_flow_header_and_origin(app):
    with TestClient(app) as client:
        sign_in(client, "1")
        assert client.post("/api/repos", json=PRIVATE).status_code == 403
        evil = {**CSRF, "Origin": "https://evil.test"}
        assert client.post("/api/repos", json=PRIVATE, headers=evil).status_code == 403
        same_site = {**CSRF, "Origin": ORIGIN}
        assert client.post("/api/repos", json=PRIVATE, headers=same_site).status_code == 202


def test_git_auth_env_sends_the_token_as_a_header_only():
    assert git_auth_env(None) == {}
    env = git_auth_env("tok")
    assert env["GIT_CONFIG_KEY_0"] == "http.https://github.com/.extraheader"
    scheme, credentials = env["GIT_CONFIG_VALUE_0"].removeprefix("Authorization: ").split()
    assert (scheme, base64.b64decode(credentials).decode()) == ("Basic", "x-access-token:tok")


def test_local_token_is_refused_for_hosted_sites(tmp_path: Path):
    Settings(tmp_path, "http://localhost:5173", github_token="tok")
    with pytest.raises(ValueError, match="local use only"):
        Settings(tmp_path, "https://code-flow.pages.dev", github_token="tok")


def test_github_app_settings_must_be_complete(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("CODEFLOW_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("GITHUB_APP_ID", "1")
    with pytest.raises(ValueError, match="GITHUB_APP_SLUG"):
        Settings.from_env()
    pem = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n"
    for name, value in {
        "GITHUB_APP_SLUG": "code-flow",
        "GITHUB_CLIENT_ID": "Iv1.client",
        "GITHUB_CLIENT_SECRET": "secret",
        "GITHUB_APP_PRIVATE_KEY": base64.b64encode(pem.encode()).decode(),
    }.items():
        monkeypatch.setenv(name, value)
    app = Settings.from_env().github_app
    assert app is not None and app.private_key == pem
    assert "secret" not in repr(app)


# GitHubApp against a recorded transport


def private_key() -> tuple[str, object]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    return pem, key.public_key()


def github_app(responses: list, pem: str = "") -> tuple[GitHubApp, list]:
    calls: list = []

    def transport(method, url, headers, body):
        calls.append((method, url, headers, json.loads(body) if body else None))
        return responses.pop(0)

    settings = GitHubAppSettings("123", "code-flow", "Iv1.client", "secret", pem)
    return GitHubApp(settings, transport, clock=lambda: 1000.0), calls


def test_exchange_code_reads_token_lifetimes():
    app, calls = github_app(
        [
            (
                200,
                {
                    "access_token": "ghu_x",
                    "expires_in": 28800,
                    "refresh_token": "ghr_y",
                    "refresh_token_expires_in": 15897600,
                },
            )
        ]
    )
    token = app.exchange_code("code", "https://site.test/cb")
    assert token == UserToken("ghu_x", 29800.0, "ghr_y", 15898600.0)
    assert calls[0][3] == {
        "client_id": "Iv1.client",
        "client_secret": "secret",
        "code": "code",
        "redirect_uri": "https://site.test/cb",
    }
    app, _ = github_app([(200, {"error": "bad_verification_code"})])
    with pytest.raises(GitHubError):
        app.exchange_code("code", "https://site.test/cb")


def test_installation_token_is_one_repo_and_read_only():
    pem, public_key = private_key()
    app, calls = github_app([(201, {"token": "ghs_1"})], pem)
    assert app.installation_token(9, 7) == "ghs_1"
    method, url, headers, body = calls[0]
    assert (method, url) == ("POST", "https://api.github.com/app/installations/9/access_tokens")
    assert body == {"repository_ids": [7], "permissions": {"contents": "read"}}
    claims = jwt.decode(
        headers["Authorization"].removeprefix("Bearer "),
        public_key,
        algorithms=["RS256"],
        options={"verify_exp": False, "verify_iat": False},
    )
    assert claims == {"iat": 940, "exp": 1540, "iss": "123"}


def test_repositories_follow_pages_across_installations():
    page = [
        {"id": n, "full_name": f"o/r{n:03}", "private": n % 2 == 0, "default_branch": "main"}
        for n in range(100)
    ]
    app, calls = github_app(
        [
            (200, {"installations": [{"id": 9}]}),
            (200, {"repositories": page}),
            (200, {"repositories": [{"id": 100, "full_name": "o/r100", "private": False}]}),
        ]
    )
    repos = app.repositories("ghu_x")
    assert len(repos) == 101 and repos[0] == GitHubRepo(0, "o/r000", True, "main", 9)
    assert calls[2][1].endswith("/user/installations/9/repositories?per_page=100&page=2")
    assert calls[0][2]["Authorization"] == "Bearer ghu_x"


def test_rejected_user_token_asks_for_a_new_sign_in():
    app, _ = github_app([(401, {"message": "Bad credentials"})])
    with pytest.raises(GitHubAuthError):
        app.user("ghu_old")
