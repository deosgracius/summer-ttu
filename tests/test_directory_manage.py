"""The Directory manager: add / edit / delete a person and have it reflected in the same
/campus/directory-admin feed the kiosk reads. Staff previously had no create/edit/delete."""
import os

os.environ["DATABASE_URL"] = "sqlite:///./test_dir_manage.db"
os.environ["CENTRAL_ADMIN_PASSWORD"] = "setup-code-xyz"
# Raise the auth rate limits so a full-suite run (which shares the in-process limiter across
# files) doesn't 429 our auth calls.
os.environ["CENTRAL_PASSCODE_PER_MIN"] = "10000"
os.environ["LOGIN_PER_MIN"] = "10000"
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ.pop("OPENAI_API_KEY", None)
if os.path.exists("test_dir_manage.db"):
    os.remove("test_dir_manage.db")

import pytest
from fastapi.testclient import TestClient
from app.main import app, _db_init

_db_init()
client = TestClient(app)


@pytest.fixture(autouse=True)
def _fix_code():
    # See test_admin_single_user: another file's module-level env set can win process-wide.
    os.environ["CENTRAL_ADMIN_PASSWORD"] = "setup-code-xyz"
    yield


def _login():
    # The setup code creates + logs in the single admin; the session cookie authenticates the rest.
    r = client.post("/auth/admin-set-password",
                    json={"passcode": "setup-code-xyz", "new_password": "adminpass1"})
    assert r.status_code == 200, r.text


def _staff(name):
    d = client.get("/campus/directory-admin").json()
    return [m for s in d["sections"] if s["key"] == "staff" for m in s["members"] if m["name"] == name]


def test_staff_create_edit_delete_shows_in_directory():
    _login()

    # CREATE a staff person with the editable fields.
    r = client.post("/campus/staff", json={
        "name": "Jane Coordinator", "title": "Coordinator", "email": "jane@ttu.edu",
        "office_building": "ECE", "office_number": "100"})
    assert r.status_code == 200, r.text

    got = _staff("Jane Coordinator")
    assert got, "new staff person is not in the directory feed"
    assert got[0]["email"] == "jane@ttu.edu"          # directory-admin now returns editable fields
    assert got[0]["office_building"] == "ECE"
    sid = got[0]["id"]

    # EDIT — the CRUD schema requires name, so the editor always sends it (as the frontend does).
    r = client.patch(f"/campus/staff/{sid}", json={"name": "Jane Coordinator", "title": "Senior Coordinator"})
    assert r.status_code == 200, r.text
    assert _staff("Jane Coordinator")[0]["title"] == "Senior Coordinator"

    # DELETE.
    r = client.delete(f"/campus/staff/{sid}")
    assert r.status_code == 200, r.text
    assert not _staff("Jane Coordinator"), "deleted staff person still in the directory feed"


def test_directory_manage_requires_auth():
    fresh = TestClient(app)  # no session cookie
    assert fresh.post("/campus/staff", json={"name": "x"}).status_code == 401
    assert fresh.delete("/campus/staff/1").status_code == 401
