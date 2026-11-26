"""Read the API's data directory and web origin from the environment."""

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    web_origin: str

    @classmethod
    def from_env(cls) -> "Settings":
        default_data_dir = Path(__file__).resolve().parents[2] / "data"
        return cls(
            data_dir=Path(os.environ.get("CODEFLOW_DATA_DIR", default_data_dir)).resolve(),
            web_origin=os.environ.get("CODEFLOW_WEB_ORIGIN", "http://localhost:5173"),
        )
