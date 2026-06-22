import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./summer.db")
_is_sqlite = DATABASE_URL.startswith("sqlite")
connect_args = {"check_same_thread": False} if _is_sqlite else {}
engine_kwargs = {"connect_args": connect_args}
if not _is_sqlite:
    # Neon (serverless Postgres) drops idle connections and suspends its compute when
    # idle. Without this, the first request after an idle period gets a dead pooled
    # connection and fails — the classic "login fails the first time, works on retry".
    # pre_ping checks the connection and transparently reconnects before the query;
    # recycle retires connections before Neon's idle cutoff so they never go stale.
    engine_kwargs["pool_pre_ping"] = True
    engine_kwargs["pool_recycle"] = 300
engine = create_engine(DATABASE_URL, **engine_kwargs)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
