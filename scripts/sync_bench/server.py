"""Run the real app on an inherited private socket."""

import json
import os
import socket
import sys
from pathlib import Path
from platform import python_version

import uvicorn

from sync_bench.workspace import fake_url, safe_port, validate_workdir


def main() -> None:
    config = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    data = validate_workdir(Path(config["data"]))
    # app.main also constructs its default app on import. Point it at the private data.
    os.environ.update(
        CODEFLOW_DATA_DIR=str(data),
        CODEFLOW_WEB_ORIGIN=config["web_origin"],
        CODEFLOW_AUTO_SYNC_INTERVAL_SECONDS="300",
        CODEFLOW_LONG_FLOW_MIN_DEPTH="4",
        CODEFLOW_FLAGSMITH_SERVER_KEY="",
        CODEFLOW_FLAGSMITH_SCOPES_PATH=str(data / "flagsmith_scopes.json"),
        FLAGSMITH_API_URL=config["web_origin"] + "/flagsmith/api/v1/",
    )
    from app.config import Settings
    from app.main import create_app

    urls = {fake_url(repo): Path(path).as_uri() for repo, path in config["upstreams"].items()}
    settings = Settings(data_dir=data, web_origin=config["web_origin"])
    app = create_app(
        settings,
        git_url_builder=urls.__getitem__,
        auto_sync_interval=config["interval"],
    )
    listener = socket.socket(fileno=config["fd"])
    safe_port(listener.getsockname()[1])
    Path(config["pid"]).write_text(str(os.getpid()), encoding="utf-8")
    Path(config["python"]).write_text(python_version(), encoding="utf-8")
    server = uvicorn.Server(uvicorn.Config(app, access_log=False, log_level="warning"))
    server.run(sockets=[listener])


if __name__ == "__main__":
    main()
