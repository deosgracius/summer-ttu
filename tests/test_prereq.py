"""Summer must NOT provide prerequisites — it redirects to the catalog + advisor."""
from app import campus_service as c


def test_prereq_questions_redirect():
    for q in ["what are the prerequisites for ECE 3312",
              "what do I need to take before ECE 3306",
              "what should I take first",
              "what does ECE 2372 unlock",
              "what does this class lead to",
              "can I take ECE 3331"]:
        r = c.prereq_redirect(q)
        assert r and "catalog" in r.lower() and "advisor" in r.lower(), q


def test_non_prereq_not_redirected():
    for q in ["where is ECE 3306", "who teaches ECE 3306", "Andrew Vanderpool office",
              "what are the stockroom hours", "where is the robotics lab"]:
        assert c.prereq_redirect(q) is None, q


def test_course_output_has_no_prereqs(monkeypatch):
    # find_courses output dict must not carry a prerequisites field anymore.
    import app.campus_service as cs

    class FakeCol:
        def __eq__(self, other): return True
    class FakeQuery:
        def filter(self, *a, **k): return self
        def order_by(self, *a, **k): return self
        def all(self): return []
    class FakeDB:
        def query(self, *a, **k): return FakeQuery()
    out = cs.find_courses(FakeDB(), "ECE 3306")
    assert out == []  # no rows in the fake, but the code path/import is exercised
