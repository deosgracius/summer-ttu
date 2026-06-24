"""Central-admin self-service: the CENTRAL_ADMIN_PASSWORD passcode gates first-time
registration and password reset only (never login), reset links are single-use, and a
wrong passcode is rejected. Calls the endpoint functions directly against an in-memory
DB (no app.main import, so the boot seed never interferes)."""
import pytest
from types import SimpleNamespace
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app import auth, models
from app.routers import auth as A


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("CENTRAL_ADMIN_PASSWORD", "passcode-xyz")
    monkeypatch.setenv("RATELIMIT_DISABLED", "1")


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


def _req():
    return SimpleNamespace(headers={}, client=SimpleNamespace(host="test"))


def test_wrong_passcode_rejected(db):
    with pytest.raises(HTTPException) as e:
        A.central_start(A.CentralStart(passcode="nope"), _req(), db)
    assert e.value.status_code == 401


def test_start_reports_no_account_then_account(db):
    assert A.central_start(A.CentralStart(passcode="passcode-xyz"), _req(), db)["has_account"] is False
    A.central_register(A.CentralRegister(passcode="passcode-xyz", email="boss@ttu.edu",
                                         password="supersecret1"), _req(), db)
    assert A.central_start(A.CentralStart(passcode="passcode-xyz"), _req(), db)["has_account"] is True


def test_register_makes_central_and_passcode_is_not_login(db):
    out = A.central_register(A.CentralRegister(passcode="passcode-xyz", email="boss@ttu.edu",
                                               password="supersecret1", location="Lubbock, TX"),
                             _req(), db)
    assert out["access_token"]
    u = db.query(models.User).filter_by(email="boss@ttu.edu").first()
    assert u.role == "central_admin" and u.approved is True
    # The real password works; the passcode is NOT a login credential.
    assert auth.verify_password("supersecret1", u.password_hash)
    assert not auth.verify_password("passcode-xyz", u.password_hash)


def test_register_blocks_second_central_under_other_email(db):
    A.central_register(A.CentralRegister(passcode="passcode-xyz", email="boss@ttu.edu",
                                         password="supersecret1"), _req(), db)
    with pytest.raises(HTTPException) as e:
        A.central_register(A.CentralRegister(passcode="passcode-xyz", email="other@ttu.edu",
                                             password="supersecret1"), _req(), db)
    assert e.value.status_code == 409


def test_reset_link_is_single_use(db):
    A.central_register(A.CentralRegister(passcode="passcode-xyz", email="boss@ttu.edu",
                                         password="supersecret1"), _req(), db)
    link = A.central_reset_link(A.CentralResetLink(passcode="passcode-xyz", email="boss@ttu.edu"),
                                _req(), db)["reset_link"]
    token = link.split("reset=")[1]
    assert A.reset(A.ResetReq(token=token, new_password="brandnew123"), _req(), db).get("reset") is True
    # Reusing the same link fails — the password fingerprint no longer matches.
    assert "error" in A.reset(A.ResetReq(token=token, new_password="another123"), _req(), db)


def test_reset_link_unknown_email_404(db):
    with pytest.raises(HTTPException) as e:
        A.central_reset_link(A.CentralResetLink(passcode="passcode-xyz", email="nobody@nowhere.edu"),
                             _req(), db)
    assert e.value.status_code == 404


def test_passcode_unset_denies(db, monkeypatch):
    monkeypatch.delenv("CENTRAL_ADMIN_PASSWORD", raising=False)
    with pytest.raises(HTTPException) as e:
        A.central_start(A.CentralStart(passcode=""), _req(), db)
    assert e.value.status_code == 401
