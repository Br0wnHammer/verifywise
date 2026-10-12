"""Shared pieces of the batched log purges (guardrail and spend logs)."""

from datetime import datetime, timedelta, timezone
from typing import Optional

# Longest retention period the settings accept: 10 years.
MAX_RETENTION_DAYS = 3650


def retention_cutoff(retention_days: int) -> Optional[datetime]:
    """The moment before which logs are older than `retention_days`.

    None when the period reaches back past the earliest representable date
    (only possible for a value saved before the settings were capped): no log
    can be that old, so there is nothing to delete.
    """
    try:
        return datetime.now(tz=timezone.utc) - timedelta(days=retention_days)
    except OverflowError:
        return None


class PartialPurgeError(Exception):
    """A purge failed after committing some batches.

    `deleted` is the number of rows already deleted (and committed) before the
    failure; the original error is chained as `__cause__`.
    """

    def __init__(self, deleted: int, cause: BaseException):
        super().__init__(str(cause))
        self.deleted = deleted
        self.__cause__ = cause
