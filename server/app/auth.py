"""Sign in with GitHub: the OAuth routes, the current user, and the repo picker list."""

import secrets

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import RedirectResponse

from app.config import Settings
from app.github import GitHubApp, GitHubAuthError, GitHubError, GitHubRepo
from app.sessions import (
    SESSION_COOKIE,
    SESSION_SECONDS,
    STATE_COOKIE,
    STATE_SECONDS,
    Session,
    SessionStore,
)

CALLBACK_PATH = "/api/auth/github/callback"
STATE_PATH = "/api/auth"
SESSION_PATH = "/api"
SIGN_IN_AGAIN = "Sign in with GitHub first"


class Auth:
    """Read the session cookie and keep the signed-in user's GitHub token fresh."""

    def __init__(self, settings: Settings, github: GitHubApp | None, sessions: SessionStore):
        self.settings = settings
        self.github = github
        self.sessions = sessions

    @property
    def callback_url(self) -> str:
        # The site proxies /api to this server, so GitHub returns to the web origin.
        return f"{self.settings.web_origin}{CALLBACK_PATH}"

    def session(self, request: Request) -> Session | None:
        return self.sessions.get(request.cookies.get(SESSION_COOKIE))

    def uid(self, request: Request) -> int | None:
        session = self.session(request)
        return session.uid if session else None

    def user_token(self, request: Request) -> tuple[Session, str]:
        """Return the session and a usable GitHub token, refreshing it when it expired."""
        github = self._github()
        session_id = request.cookies.get(SESSION_COOKIE)
        session = self.sessions.get(session_id)
        if session is None or session_id is None:
            raise HTTPException(status_code=401, detail=SIGN_IN_AGAIN)
        if self.sessions.access_expired(session):
            refresh_token = self.sessions.refresh_token(session)
            if not self.sessions.can_refresh(session) or refresh_token is None:
                self.sessions.delete(session_id)
                raise HTTPException(status_code=401, detail=SIGN_IN_AGAIN)
            try:
                token = github.refresh(refresh_token)
            except GitHubError:
                self.sessions.delete(session_id)
                raise HTTPException(status_code=401, detail=SIGN_IN_AGAIN) from None
            session = self.sessions.update_token(session_id, token) or session
        return session, self.sessions.access_token(session)

    def repositories(self, request: Request) -> tuple[Session, list[GitHubRepo]]:
        session, token = self.user_token(request)
        try:
            return session, self._github().repositories(token)
        except GitHubAuthError as exc:
            self.sessions.delete(request.cookies.get(SESSION_COOKIE))
            raise HTTPException(status_code=401, detail=str(exc)) from exc
        except GitHubError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    def _github(self) -> GitHubApp:
        if self.github is None:
            raise HTTPException(status_code=404, detail="GitHub sign-in is not set up")
        return self.github

    def _cookie(self, response: Response, name: str, value: str, max_age: int, path: str):
        response.set_cookie(
            name,
            value,
            max_age=max_age,
            path=path,
            httponly=True,
            secure=self.settings.secure_cookies,
            samesite="lax",
        )

    def _back_to_site(self, query: str) -> RedirectResponse:
        response = RedirectResponse(f"{self.settings.web_origin}/?{query}", status_code=302)
        response.delete_cookie(STATE_COOKIE, path=STATE_PATH)
        return response

    def router(self) -> APIRouter:
        router = APIRouter()

        @router.get("/api/auth/github/login")
        def login() -> RedirectResponse:
            github = self._github()
            state = secrets.token_urlsafe(24)
            response = RedirectResponse(github.authorize_url(self.callback_url, state), 302)
            self._cookie(
                response, STATE_COOKIE, self.sessions.seal_state(state), STATE_SECONDS, STATE_PATH
            )
            return response

        @router.get(CALLBACK_PATH)
        def callback(
            request: Request,
            code: str | None = None,
            state: str | None = None,
            error: str | None = None,
        ) -> RedirectResponse:
            github = self._github()
            if error:
                return self._back_to_site("signin_error=denied")
            if not code or not self.sessions.state_matches(
                request.cookies.get(STATE_COOKIE), state
            ):
                return self._back_to_site("signin_error=expired")
            try:
                token = github.exchange_code(code, self.callback_url)
                user = github.user(token.access_token)
            except GitHubError:
                return self._back_to_site("signin_error=github")

            self.sessions.delete(request.cookies.get(SESSION_COOKIE))
            session_id = self.sessions.create(user, token)
            response = self._back_to_site("signed_in=1")
            self._cookie(response, SESSION_COOKIE, session_id, SESSION_SECONDS, SESSION_PATH)
            return response

        @router.get("/api/me")
        def me(request: Request) -> dict:
            session = self.session(request)
            if self.github is None or session is None:
                return {"configured": self.github is not None, "signed_in": False}
            return {
                "configured": True,
                "signed_in": True,
                "login": session.login,
                "avatar_url": session.avatar_url,
                "install_url": self.github.install_url(),
            }

        @router.get("/api/github/repos")
        def github_repos(request: Request) -> list[dict]:
            _, repos = self.repositories(request)
            return [repo.response() for repo in repos]

        @router.post("/api/auth/logout", status_code=204)
        def logout(request: Request) -> Response:
            session = self.sessions.delete(request.cookies.get(SESSION_COOKIE))
            if session is not None and self.github is not None:
                self.github.revoke(self.sessions.access_token(session))
            response = Response(status_code=204)
            response.delete_cookie(
                SESSION_COOKIE,
                path=SESSION_PATH,
                httponly=True,
                secure=self.settings.secure_cookies,
                samesite="lax",
            )
            return response

        return router
