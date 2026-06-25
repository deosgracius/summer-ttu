"""Login attempts (success and failure) are written to the audit log with the client
IP, so an intrusion review can query who tried to sign in and when."""
from types import SimpleNamespace
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app import models
from app.routers import auth as A


def _db():
    eng = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(eng)
    return sessionmaker(bind=eng)()


def _req(ip="1.2.3.4"):
    return SimpleNamespace(headers={"x-forwarded-for": ip}, client=SimpleNamespace(host=ip))


def test_failed_login_is_audited_with_ip():
    db = _db()
    A._log_login(db, _req("9.9.9.9"), False, email="attacker@x.com", reason="bad password")
    rows = db.query(models.AuditLog).all()
    assert len(rows) == 1
    r = rows[0]
    assert r.action == "login_failed"
    assert "9.9.9.9" in r.summary and "attacker@x.com" in r.summary


def test_successful_login_is_audited_with_actor_and_ip():
    db = _db()
    u = models.User(email="center@ttu.edu", password_hash="x", role="central_admin")
    db.add(u); db.commit()
    A._log_login(db, _req("5.6.7.8"), True, user=u)
    rows = db.query(models.AuditLog).filter_by(action="login").all()
    assert len(rows) == 1
    assert rows[0].actor_email == "center@ttu.edu" and "5.6.7.8" in rows[0].summary
