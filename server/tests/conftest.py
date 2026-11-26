"""Build and analyze the shared shop demo fixture."""

import shutil
import subprocess
from pathlib import Path

import pytest
from codeflow.analyze import analyze_repo, load_commits
from codeflow.graph import Commit


@pytest.fixture(scope="module")
def demo_data(tmp_path_factory: pytest.TempPathFactory) -> Path:
    if shutil.which("git") is None:
        pytest.skip("git is required to build the shop demo")
    root = tmp_path_factory.mktemp("shop-demo")
    repo = root / "shop-demo"
    script = Path(__file__).resolve().parents[2] / "examples" / "make_shop_demo.sh"
    subprocess.run(["bash", str(script), str(repo)], check=True, capture_output=True)
    data_dir = root / "data"
    analyze_repo(repo, data_dir / "shop-demo", branch="main")
    return data_dir


@pytest.fixture
def checkout_commit(demo_data: Path) -> Commit:
    return next(
        commit
        for commit in load_commits(demo_data / "shop-demo")
        if commit.message == "Add new_checkout behind flag new_checkout"
    )
