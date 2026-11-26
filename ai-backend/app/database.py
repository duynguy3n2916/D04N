from contextlib import contextmanager

import time

from sqlalchemy import create_engine, event
from sqlalchemy.orm import declarative_base, sessionmaker

from app.config import settings

if not settings.database_url:
    raise RuntimeError("Thiếu DATABASE_URL trong .env (chuỗi kết nối Postgres cloud, ví dụ Neon).")
engine = create_engine(settings.database_url, pool_pre_ping=True, pool_size=10, max_overflow=10)
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False, expire_on_commit=False)
Base = declarative_base()


@event.listens_for(engine, "before_cursor_execute")
def _count_query_start(conn, cursor, statement, parameters, context, executemany):
    conn.info["_q_t0"] = time.perf_counter()


@event.listens_for(engine, "after_cursor_execute")
def _count_query_end(conn, cursor, statement, parameters, context, executemany):
    """Đếm số truy vấn và tổng thời gian chờ DB của request (hiện ở header X-DB-Queries / Server-Timing)."""
    from app.core.context import get_db_stats
    stats = get_db_stats()
    if stats is not None:
        stats["queries"] += 1
        stats["ms"] += (time.perf_counter() - conn.info.pop("_q_t0", time.perf_counter())) * 1000


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def session_scope():
    """Session độc lập cho job nền / tác vụ ngoài request."""
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
