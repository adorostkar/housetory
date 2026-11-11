from collections.abc import AsyncIterator

from anyio import CancelScope, CapacityLimiter, to_thread
from anyio.lowlevel import RunVar
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from .config import get_settings

_settings = get_settings()
POOL_SIZE = 5
POOL_OVERFLOW = 10
_request_limiter = RunVar[CapacityLimiter]("database_request_limiter")

engine = create_engine(
    _settings.database_url,
    pool_pre_ping=True,
    pool_size=POOL_SIZE,
    max_overflow=POOL_OVERFLOW,
    pool_recycle=1800,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


async def get_db() -> AsyncIterator[Session]:
    try:
        limiter = _request_limiter.get()
    except LookupError:
        limiter = CapacityLimiter(POOL_SIZE + POOL_OVERFLOW)
        _request_limiter.set(limiter)
    # Wait before sync dependencies can occupy every worker with pool checkouts.
    async with limiter:
        db = SessionLocal()
        try:
            yield db
        finally:
            with CancelScope(shield=True):
                await to_thread.run_sync(db.close, limiter=CapacityLimiter(1))
