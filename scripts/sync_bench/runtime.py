"""Run the benchmark's loopback web and API services and query their measurements."""

import json
import os
import signal
import socket
import subprocess
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from functools import partial
from hmac import compare_digest
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from time import monotonic, sleep
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener

from sync_bench.workspace import ROOT, git_env, safe_port

HOST = "127.0.0.1"


class WebHandler(SimpleHTTPRequestHandler):
    """Serve a Vite build with SPA fallback and an isolated Flagsmith preview fixture."""

    def __init__(self, *args: object, directory: str, key: str) -> None:
        self.key = key
        super().__init__(*args, directory=directory)

    def log_message(self, _format: str, *args: object) -> None:
        pass

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path in ("/flagsmith/api/v1/identities/", "/flagsmith/api/v1/flags/"):
            self._preview_flags()
            return
        if not Path(self.translate_path(path)).is_file() and not Path(path).suffix:
            self.path = "/index.html"
        super().do_GET()

    def _preview_flags(self) -> None:
        if not compare_digest(self.headers.get("X-Environment-Key", ""), self.key):
            self.send_error(403)
            return
        flags = [
            {
                "feature": {"id": number, "name": name, "type": kind},
                "enabled": True,
                "feature_state_value": value,
            }
            for number, (name, kind, value) in enumerate(
                [
                    ("variant_preview", "STANDARD", None),
                    ("sync_mode", "MULTIVARIATE", "manual_button"),
                ],
                start=1,
            )
        ]
        payload = (
            {"flags": flags, "traits": []} if "identities/" in self.path else flags
        )
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def development_key() -> str:
    name = "CODEFLOW_SIM_FLAGSMITH_ENV_KEY"
    if name in os.environ:
        return os.environ[name].strip()
    try:
        lines = (ROOT / ".env").read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return ""
    for line in lines:
        key, _, value = line.strip().removeprefix("export ").partition("=")
        if key.strip() == name:
            value = value.strip()
            if value and value[0] in ("'", '"'):
                return value[1:].partition(value[0])[0]
            return value.partition(" #")[0].strip()
    return ""


@contextmanager
def api_listener() -> Iterator[socket.socket]:
    with socket.socket() as listener:
        listener.bind((HOST, 0))
        safe_port(listener.getsockname()[1])
        listener.listen()
        yield listener


@contextmanager
def web_server(directory: Path, key: str) -> Iterator[str]:
    handler = partial(WebHandler, directory=str(directory), key=key)
    with ThreadingHTTPServer((HOST, 0), handler, bind_and_activate=False) as server:
        server.server_bind()
        port = safe_port(server.server_port)
        server.server_activate()
        thread = Thread(target=server.serve_forever, daemon=True)
        try:
            thread.start()
            yield f"http://{HOST}:{port}"
        finally:
            if thread.is_alive():
                server.shutdown()
                thread.join()


def stop_process_group(
    process: subprocess.Popen, first_signal: signal.Signals = signal.SIGTERM
) -> None:
    try:
        with suppress(ProcessLookupError):
            os.killpg(process.pid, first_signal)
        with suppress(subprocess.TimeoutExpired):
            process.wait(timeout=10)
    finally:
        # The group can outlive its leader (uv, npm, or the Chrome driver).
        with suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def build_web(directory: Path, api_origin: str, web_origin: str, key: str) -> None:
    env = {
        **os.environ,
        "VITE_API_URL": api_origin,
        "VITE_CODEFLOW_FLAGSMITH_ENV_KEY": key,
        "VITE_FLAGSMITH_API_URL": web_origin + "/flagsmith/api/v1/",
    }
    # Build output can include inlined client config. Keep it private and suppress tool output.
    with subprocess.Popen(
        ["npm", "run", "build", "--", "--outDir", str(directory), "--emptyOutDir"],
        cwd=ROOT / "web",
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    ) as process:
        try:
            status = process.wait(timeout=180)
        finally:
            stop_process_group(process)
    if status:
        raise RuntimeError(
            "Benchmark web build failed. Check 'npm run build' under web/."
        )


class Api:
    def __init__(self, port: int) -> None:
        self.port = safe_port(port)
        self.origin = f"http://{HOST}:{self.port}"
        self.opener = build_opener(ProxyHandler({}))

    def request(
        self,
        path: str,
        method: str = "GET",
        payload: dict | None = None,
        *,
        timeout: float = 120,
    ) -> object:
        request = Request(
            self.origin + "/api/" + path,
            data=None if payload is None else json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"} if payload is not None else {},
            method=method,
        )
        with self.opener.open(request, timeout=timeout) as response:
            return json.load(response)


class RunningApi:
    def __init__(self, directory: Path, port: int) -> None:
        self.api = Api(port)
        self.trace = directory / "git-trace.jsonl"
        self.pid_file = directory / "server.pid"
        self.python_file = directory / "python-version"

    @property
    def pid(self) -> int:
        return int(self.pid_file.read_text(encoding="utf-8"))


@contextmanager
def api_server(
    directory: Path,
    listener: socket.socket,
    data: Path,
    upstreams: dict[str, Path],
    web_origin: str,
    interval: float,
) -> Iterator[RunningApi]:
    fd = listener.fileno()
    running = RunningApi(directory, listener.getsockname()[1])
    config = directory / "server.json"
    config.write_text(
        json.dumps(
            {
                "data": str(data),
                "upstreams": {repo: str(path) for repo, path in upstreams.items()},
                "web_origin": web_origin,
                "interval": interval,
                "fd": fd,
                "pid": str(running.pid_file),
                "python": str(running.python_file),
            }
        ),
        encoding="utf-8",
    )
    env = {
        **git_env(),
        "PYTHONPATH": str(ROOT / "scripts"),
        "GIT_TRACE2_EVENT": str(running.trace),
    }
    with (directory / "server.log").open("wb") as log:
        process = subprocess.Popen(
            [
                "uv",
                "run",
                "--project",
                str(ROOT / "server"),
                "python",
                "-m",
                "sync_bench.server",
                str(config),
            ],
            cwd=directory,
            env=env,
            pass_fds=(fd,),
            stdout=log,
            stderr=log,
            start_new_session=True,
        )
        try:
            deadline = monotonic() + 35
            while monotonic() < deadline and process.poll() is None:
                # The parent owns the listening socket until the child has bound Uvicorn.
                if running.pid_file.exists():
                    try:
                        running.api.request("health", timeout=0.5)
                    except (URLError, TimeoutError):
                        pass
                    else:
                        listener.close()
                        break
                sleep(0.1)
            else:
                raise RuntimeError(f"Benchmark API did not start. See {log.name}.")
            yield running
        finally:
            stop_process_group(process)
