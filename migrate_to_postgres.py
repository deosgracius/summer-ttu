"""One-shot data migration: SQLite (summer.db) -> managed Postgres.

Copies every table in foreign-key-safe order, then fixes Postgres' auto-increment
sequences so future inserts don't collide with the migrated IDs.

Usage:
    1. Put your managed-Postgres URL in .env as DATABASE_URL (postgresql+psycopg://...).
       Keep the old SQLite file (summer.db) in place — it's the source.
    2. python migrate_to_postgres.py

It reads the SOURCE from summer.db directly and the TARGET from DATABASE_URL, so it
never depends on which one the app is currently pointed at."""
import os
import re
import pathlib
import sys
from sqlalchemy import create_engine, select, insert, text


def _load_env():
    for line in pathlib.Path(".env").read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if s and not s.startswith("#") and "=" in s:
            k, v = s.split("=", 1)
            os.environ.setdefault(k.strip(), re.sub(r"\s+#.*$", "", v.strip()))


def main():
    _load_env()
    target_url = os.environ.get("DATABASE_URL", "")
    if not target_url or target_url.startswith("sqlite"):
        sys.exit("DATABASE_URL must be set to your Postgres URL in .env first.")

    # Import models so every table is registered on Base.metadata.
    from app.database import Base
    import app.models  # noqa: F401

    src = create_engine("sqlite:///./summer.db")
    dst = create_engine(target_url)

    print(f"Source: summer.db   ->   Target: {target_url.split('@')[-1]}")
    Base.metadata.create_all(dst)  # build the schema on Postgres

    total = 0
    with src.connect() as s, dst.begin() as d:
        for table in Base.metadata.sorted_tables:  # FK-dependency order
            try:
                rows = [dict(r._mapping) for r in s.execute(select(table))]
            except Exception as e:
                print(f"  skip {table.name}: {e}")
                continue
            if rows:
                d.execute(insert(table), rows)
            total += len(rows)
            print(f"  {table.name:<22} {len(rows)} rows")

    # Reset sequences for integer 'id' PKs so the next insert gets a fresh id.
    with dst.begin() as d:
        for table in Base.metadata.sorted_tables:
            if "id" in table.c and str(table.c["id"].type).upper().startswith("INTEGER"):
                d.execute(text(
                    f"SELECT setval(pg_get_serial_sequence('{table.name}', 'id'), "
                    f"COALESCE((SELECT MAX(id) FROM {table.name}), 1), true)"))

    print(f"\nDone. Migrated {total} rows. Sequences reset. "
          f"Restart the backend (it now uses Postgres).")


if __name__ == "__main__":
    main()
