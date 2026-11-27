"""Talk to GitHub for sign-in, the repo picker, and short-lived clone tokens."""

import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from urllib.parse import urlencode

import jwt
import urllib3

from app.config import GitHubAppSettings

GITHUB_WEB = "https://github.com"
GITHUB_API = "https://api.github.com"
PAGE_SIZE = 100
MAX_PAGES = 5

# A transport sends one request and returns the status code and the decoded JSON body.
Transport = Callable[[str, str, dict[str, str], bytes | None], tuple[int, object]]

_pool = urllib3.PoolManager()


def urllib3_transport(
    method: str, url: str, headers: dict[str, str], body: bytes | None
) -> tuple[int, object]:
    try:
        response = _pool.request(
            method, url, headers=headers, body=body, timeout=20.0, retries=False
        )
    except urllib3.exceptions.HTTPError as exc:
        raise GitHubError("Could not reach GitHub") from exc
    try:
        data = json.loads(response.data) if response.data else None
    except ValueError:
        data = None
    return response.status, data


class GitHubError(RuntimeError):
    """GitHub refused or failed a request. The message is safe to show."""


class GitHubAuthError(GitHubError):
    """GitHub no longer accepts the user's token, so they must sign in again."""


@dataclass(frozen=True)
class UserToken:
    """A user access token with its refresh token. Times are Unix seconds."""

    access_token: str
    expires_at: float | None
    refresh_token: str | None
    refresh_expires_at: float | None


@dataclass(frozen=True)
class GitHubUser:
    id: int
    login: str
    avatar_url: str


@dataclass(frozen=True)
class GitHubRepo:
    """A repository the signed-in user can pick, through one app installation."""

    id: int
    full_name: str
    private: bool
    default_branch: str
    installation_id: int

    def response(self) -> dict:
        return {
            "id": self.id,
            "full_name": self.full_name,
            "private": self.private,
            "default_branch": self.default_branch,
            "installation_id": self.installation_id,
        }


class GitHubApp:
    """The GitHub App's OAuth and REST calls. Tokens never leave the server."""

    def __init__(
        self,
        settings: GitHubAppSettings,
        transport: Transport = urllib3_transport,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.settings = settings
        self._transport = transport
        self._clock = clock

    # Sign-in

    def authorize_url(self, redirect_uri: str, state: str) -> str:
        query = urlencode(
            {"client_id": self.settings.client_id, "redirect_uri": redirect_uri, "state": state}
        )
        return f"{GITHUB_WEB}/login/oauth/authorize?{query}"

    def install_url(self) -> str:
        return f"{GITHUB_WEB}/apps/{self.settings.slug}/installations/new"

    def exchange_code(self, code: str, redirect_uri: str) -> UserToken:
        return self._token_request(
            {"code": code, "redirect_uri": redirect_uri}, "GitHub did not accept the sign-in"
        )

    def refresh(self, refresh_token: str) -> UserToken:
        return self._token_request(
            {"grant_type": "refresh_token", "refresh_token": refresh_token},
            "GitHub sign-in expired",
        )

    def _token_request(self, fields: dict[str, str], error: str) -> UserToken:
        body = {
            "client_id": self.settings.client_id,
            "client_secret": self.settings.client_secret,
            **fields,
        }
        status, data = self._transport(
            "POST",
            f"{GITHUB_WEB}/login/oauth/access_token",
            {"Accept": "application/json", "Content-Type": "application/json"},
            json.dumps(body).encode(),
        )
        # GitHub answers 200 with an "error" field when the code or refresh token is bad.
        if status != 200 or not isinstance(data, dict) or "access_token" not in data:
            raise GitHubError(error)
        now = self._clock()

        def expiry(name: str) -> float | None:
            seconds = data.get(name)
            return now + int(seconds) if seconds else None

        return UserToken(
            access_token=str(data["access_token"]),
            expires_at=expiry("expires_in"),
            refresh_token=data.get("refresh_token"),
            refresh_expires_at=expiry("refresh_token_expires_in"),
        )

    def revoke(self, access_token: str) -> None:
        """Revoke a user token on sign-out. Failures are ignored."""
        credentials = f"{self.settings.client_id}:{self.settings.client_secret}"
        headers = urllib3.make_headers(basic_auth=credentials)
        try:
            self._transport(
                "DELETE",
                f"{GITHUB_API}/applications/{self.settings.client_id}/token",
                {**self._api_headers(), **headers},
                json.dumps({"access_token": access_token}).encode(),
            )
        except GitHubError:
            pass

    # User calls

    def user(self, access_token: str) -> GitHubUser:
        data = self._get(f"{GITHUB_API}/user", access_token, "Could not read your GitHub profile")
        return GitHubUser(int(data["id"]), str(data["login"]), str(data.get("avatar_url", "")))

    def repositories(self, access_token: str) -> list[GitHubRepo]:
        """List repos the user can see through every installation of this app."""
        installations = self._get_pages(
            f"{GITHUB_API}/user/installations", "installations", access_token
        )
        repos = []
        for installation in installations:
            installation_id = int(installation["id"])
            for repo in self._get_pages(
                f"{GITHUB_API}/user/installations/{installation_id}/repositories",
                "repositories",
                access_token,
            ):
                repos.append(
                    GitHubRepo(
                        id=int(repo["id"]),
                        full_name=str(repo["full_name"]),
                        private=bool(repo["private"]),
                        default_branch=str(repo.get("default_branch", "")),
                        installation_id=installation_id,
                    )
                )
        return sorted(repos, key=lambda repo: repo.full_name.lower())

    # App calls

    def installation_token(self, installation_id: int, repository_id: int) -> str:
        """Mint a 1-hour token that can only read the contents of one repository."""
        status, data = self._transport(
            "POST",
            f"{GITHUB_API}/app/installations/{installation_id}/access_tokens",
            {**self._api_headers(), "Authorization": f"Bearer {self._app_jwt()}"},
            json.dumps(
                {"repository_ids": [repository_id], "permissions": {"contents": "read"}}
            ).encode(),
        )
        if status != 201 or not isinstance(data, dict) or "token" not in data:
            raise GitHubError("Could not get access to this repository on GitHub")
        return str(data["token"])

    def _app_jwt(self) -> str:
        now = int(self._clock())
        # Backdate a minute for clock drift; GitHub accepts at most ten minutes.
        claims = {"iat": now - 60, "exp": now + 540, "iss": self.settings.app_id}
        return jwt.encode(claims, self.settings.private_key, algorithm="RS256")

    # Helpers

    @staticmethod
    def _api_headers() -> dict[str, str]:
        return {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "code-flow",
        }

    def _get(self, url: str, access_token: str, error: str) -> dict:
        status, data = self._transport(
            "GET", url, {**self._api_headers(), "Authorization": f"Bearer {access_token}"}, None
        )
        if status == 401:
            raise GitHubAuthError("Your GitHub sign-in expired. Sign in again.")
        if status != 200 or not isinstance(data, dict):
            raise GitHubError(error)
        return data

    def _get_pages(self, url: str, key: str, access_token: str) -> list[dict]:
        items: list[dict] = []
        for page in range(1, MAX_PAGES + 1):
            data = self._get(
                f"{url}?per_page={PAGE_SIZE}&page={page}",
                access_token,
                "Could not list your GitHub repositories",
            )
            batch = data.get(key, [])
            items.extend(batch)
            if len(batch) < PAGE_SIZE:
                break
        return items
