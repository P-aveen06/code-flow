"""Decide who may read an imported repository."""


def can_read(source: dict, uid: int | None) -> bool:
    """Public imports are shared. A private import is readable only by its owner."""
    if source.get("visibility", "public") != "private":
        return True
    return uid is not None and source.get("owner_uid") == uid
