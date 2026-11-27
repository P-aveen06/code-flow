"""Keep signed-in users on the server: the cookie holds only a random session id.

GitHub tokens are encrypted in memory with a key made at startup, so a restart
signs everyone out. That matches the free Render host, whose imports reset too.
"""

import hashlib
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass, replace
from threading import Lock

from cryptography.fernet import Fernet, InvalidToken

from app.github import GitHubUser, UserToken

SESSION_COOKIE = "cf_session"
STATE_COOKIE = "cf_oauth_state"
SESSION_SECONDS = 7 * 24 * 60 * 60
STATE_SECONDS = 10 * 60


@dataclass(frozen=True)
class Session:
    """A signed-in GitHub user. Token fields hold encrypted bytes, never plain text."""

    uid: int
    login: str
    avatar_url: str
    access_token: bytes
    expires_at: float | None
    refresh_token: bytes | None
    refresh_expires_at: float | None
    created_at: float


def _key(session_id: str) -> str:
    # Store a hash so a memory dump does not reveal usable cookie values.
    return hashlib.sha256(session_id.encode()).hexdigest()


class SessionStore:
    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._fernet = Fernet(Fernet.generate_key())
        self._clock = clock
        self._lock = Lock()
        self._sessions: dict[str, Session] = {}

    def create(self, user: GitHubUser, token: UserToken) -> str:
        session_id = secrets.token_urlsafe(32)
        session = Session(
            uid=user.id,
            login=user.login,
            avatar_url=user.avatar_url,
            created_at=self._clock(),
            **self._encrypted(token),
        )
        with self._lock:
            self._drop_expired()
            self._sessions[_key(session_id)] = session
        return session_id

    def get(self, session_id: str | None) -> Session | None:
        if not session_id:
            return None
        with self._lock:
            session = self._sessions.get(_key(session_id))
            if session and self._clock() - session.created_at > SESSION_SECONDS:
                del self._sessions[_key(session_id)]
                return None
            return session

    def update_token(self, session_id: str, token: UserToken) -> Session | None:
        with self._lock:
            session = self._sessions.get(_key(session_id))
            if session is None:
                return None
            session = replace(session, **self._encrypted(token))
            self._sessions[_key(session_id)] = session
            return session

    def delete(self, session_id: str | None) -> Session | None:
        if not session_id:
            return None
        with self._lock:
            return self._sessions.pop(_key(session_id), None)

    def access_token(self, session: Session) -> str:
        return self._fernet.decrypt(session.access_token).decode()

    def refresh_token(self, session: Session) -> str | None:
        if session.refresh_token is None:
            return None
        return self._fernet.decrypt(session.refresh_token).decode()

    def access_expired(self, session: Session, margin: float = 60) -> bool:
        return session.expires_at is not None and self._clock() > session.expires_at - margin

    def can_refresh(self, session: Session) -> bool:
        return session.refresh_token is not None and (
            session.refresh_expires_at is None or self._clock() < session.refresh_expires_at
        )

    # OAuth state: a random value sealed into a short-lived cookie.

    def seal_state(self, state: str) -> str:
        return self._fernet.encrypt(state.encode()).decode()

    def state_matches(self, sealed: str | None, state: str | None) -> bool:
        if not sealed or not state:
            return False
        try:
            expected = self._fernet.decrypt(sealed.encode(), ttl=STATE_SECONDS).decode()
        except InvalidToken:
            return False
        return secrets.compare_digest(expected, state)

    def _encrypted(self, token: UserToken) -> dict:
        return {
            "access_token": self._fernet.encrypt(token.access_token.encode()),
            "expires_at": token.expires_at,
            "refresh_token": (
                self._fernet.encrypt(token.refresh_token.encode()) if token.refresh_token else None
            ),
            "refresh_expires_at": token.refresh_expires_at,
        }

    def _drop_expired(self) -> None:
        now = self._clock()
        for key in [k for k, s in self._sessions.items() if now - s.created_at > SESSION_SECONDS]:
            del self._sessions[key]
