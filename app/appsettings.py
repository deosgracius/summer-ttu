"""Tiny runtime key/value settings store (DB-backed)."""
from . import models


def get(db, key: str, default: str = "") -> str:
    row = db.get(models.AppSetting, key)
    return row.value if (row and row.value) else default


def set(db, key: str, value: str):
    row = db.get(models.AppSetting, key)
    if row:
        row.value = value
    else:
        db.add(models.AppSetting(key=key, value=value))
    db.commit()
