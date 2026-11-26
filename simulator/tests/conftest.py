"""Keep simulator tests offline at the HTTP transport boundary."""

import pytest
from requests import PreparedRequest, Response, Session


@pytest.fixture(autouse=True)
def block_http(monkeypatch: pytest.MonkeyPatch) -> None:
    def unexpected_request(
        session: Session, request: PreparedRequest, **kwargs: object
    ) -> Response:
        pytest.fail("Simulator tests must stub HTTP requests.")

    monkeypatch.setattr(Session, "send", unexpected_request)
