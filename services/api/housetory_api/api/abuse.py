"""Small in-process abuse controls for credential endpoints.

The Compose deployment runs one API process. This limiter is deliberately
in-memory and resets on restart; PostgreSQL-backed throttling would be required
before horizontally scaling the API. Tailscale access control remains the
primary boundary.
"""

import hashlib
import threading
import time
from collections import defaultdict, deque

from ..config import get_settings
from .errors import ApiError


class LoginLimiter:
    MAX_TRACKED_KEYS = 5_000

    def __init__(self) -> None:
        self._failures: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    @staticmethod
    def email_key(email: str) -> str:
        digest = hashlib.sha256(email.strip().lower().encode("utf-8")).hexdigest()
        return f"email:{digest}"

    @staticmethod
    def ip_key(ip_address: str | None) -> str | None:
        if not ip_address:
            return None
        digest = hashlib.sha256(ip_address.encode("utf-8")).hexdigest()
        return f"ip:{digest}"

    def _prune(self, key: str, now: float, window_seconds: int) -> None:
        failures = self._failures[key]
        cutoff = now - window_seconds
        while failures and failures[0] < cutoff:
            failures.popleft()
        if not failures:
            self._failures.pop(key, None)

    def retry_after(self, keys: list[str]) -> int | None:
        settings = get_settings()
        now = time.monotonic()
        window = settings.login_window_seconds
        with self._lock:
            retry: int | None = None
            for key in keys:
                self._prune(key, now, window)
                failures = self._failures.get(key)
                if failures and len(failures) >= settings.login_max_failures:
                    seconds = max(1, int(failures[0] + window - now) + 1)
                    retry = max(retry or 0, seconds)
            return retry

    def record_failure(self, keys: list[str]) -> None:
        settings = get_settings()
        now = time.monotonic()
        with self._lock:
            for key in keys:
                self._prune(key, now, settings.login_window_seconds)
                self._failures[key].append(now)
            if len(self._failures) > self.MAX_TRACKED_KEYS:
                for existing in list(self._failures):
                    self._prune(existing, now, settings.login_window_seconds)
                while len(self._failures) > self.MAX_TRACKED_KEYS:
                    self._failures.pop(next(iter(self._failures)), None)

    def clear(self, keys: list[str]) -> None:
        with self._lock:
            for key in keys:
                self._failures.pop(key, None)

    def reset_all(self) -> None:
        with self._lock:
            self._failures.clear()


login_limiter = LoginLimiter()


def enforce_login_limit(keys: list[str]) -> None:
    retry = login_limiter.retry_after(keys)
    if retry is not None:
        raise ApiError(
            429,
            "too_many_attempts",
            f"Too many sign-in attempts. Try again in {retry} seconds.",
            headers={"Retry-After": str(retry)},
        )
