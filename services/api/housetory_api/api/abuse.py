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


class RequestLimiter:
    """Simple bounded request-rate guard for expensive read fanout.

    This is deliberately in-process like the credential limiter. It is a
    usability and abuse bound, not a security boundary.
    """

    def __init__(self, *, max_requests: int, window_seconds: int) -> None:
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._requests: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, key: str) -> None:
        now = time.monotonic()
        cutoff = now - self.window_seconds
        with self._lock:
            requests = self._requests[key]
            while requests and requests[0] < cutoff:
                requests.popleft()
            if len(requests) >= self.max_requests:
                retry = max(1, int(requests[0] + self.window_seconds - now) + 1)
                raise ApiError(
                    429,
                    "too_many_requests",
                    f"Too many search requests. Try again in {retry} seconds.",
                    headers={"Retry-After": str(retry)},
                )
            requests.append(now)
            if len(self._requests) > 5_000:
                for existing in list(self._requests):
                    if existing == key:
                        continue
                    values = self._requests[existing]
                    while values and values[0] < cutoff:
                        values.popleft()
                    if not values:
                        self._requests.pop(existing, None)

    def reset_all(self) -> None:
        with self._lock:
            self._requests.clear()


search_limiter = RequestLimiter(max_requests=300, window_seconds=60)


def enforce_search_limit(user_id) -> None:  # noqa: ANN001
    search_limiter.check(f"search:{user_id}")
