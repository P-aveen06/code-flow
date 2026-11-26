"""Keep simulator tests offline at the HTTP transport boundary."""

import pytest
from requests import PreparedRequest, Response, Session

from experiments import Experiment, load_experiment
from personas import PersonaModel, load_personas
from simulate import EXPERIMENTS_DIR, SIMULATOR_DIR


@pytest.fixture
def personas() -> PersonaModel:
    return load_personas(SIMULATOR_DIR / "personas.yaml")


@pytest.fixture
def flow_view(personas: PersonaModel) -> Experiment:
    return load_experiment(EXPERIMENTS_DIR / "flow_view.yaml", personas)


@pytest.fixture(autouse=True)
def block_http(monkeypatch: pytest.MonkeyPatch) -> None:
    def unexpected_request(
        session: Session, request: PreparedRequest, **kwargs: object
    ) -> Response:
        pytest.fail("Simulator tests must stub HTTP requests.")

    monkeypatch.setattr(Session, "send", unexpected_request)
