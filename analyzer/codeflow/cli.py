"""Provide the code-flow command-line entry point."""

import argparse

from codeflow import __version__


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="code-flow", description="git for code flow")
    parser.add_argument("--version", action="version", version=__version__)
    parser.parse_args(argv)
    parser.print_help()
    return 0
