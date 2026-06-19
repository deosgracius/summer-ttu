from sqlalchemy import (Column, Integer, String, Boolean, DateTime, ForeignKey,
                        UniqueConstraint, func, Float)
from sqlalchemy.orm import relationship
from .database import Base


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=False)
    role = Column(String, nullable=False, default="customer")
    location = Column(String, nullable=False, default="")
    profile_json = Column(String, default='{}')
    language = Column(String, nullable=False, default="English")
    timezone = Column(String, nullable=False, default="")
    created_at = Column(DateTime, server_default=func.now())
    tasks = relationship("Task", back_populates="owner", cascade="all, delete-orphan")


class Task(Base):
    __tablename__ = "tasks"
    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, nullable=False)
    done = Column(Boolean, default=False, nullable=False)
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, server_default=func.now())
    owner = relationship("User", back_populates="tasks")


class Event(Base):
    __tablename__ = "events"
    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, nullable=False)
    when_text = Column(String, nullable=False, default="")
    capacity = Column(Integer, nullable=False, default=0)
    booked = Column(Integer, nullable=False, default=0)
    owner_id = Column(Integer, ForeignKey("users.id"))
    status = Column(String, nullable=False, default="approved")
    location = Column(String)
    speaker = Column(String)
    image_url = Column(String)
    description = Column(String)
    layout = Column(String, default="theater")


class EventCategory(Base):
    __tablename__ = "event_categories"
    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), nullable=False)
    name = Column(String, nullable=False)
    price = Column(Float, nullable=False, default=0)
    capacity = Column(Integer, nullable=False, default=0)
    booked = Column(Integer, nullable=False, default=0)


class Booking(Base):
    __tablename__ = "bookings"
    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, server_default=func.now())
    category_id = Column(Integer, ForeignKey("event_categories.id"))
    quantity = Column(Integer, nullable=False, default=1)
    amount = Column(Float, nullable=False, default=0)
    details = Column(String)
    __table_args__ = (UniqueConstraint("event_id", "user_id", name="uq_event_user"),)


class Reminder(Base):
    __tablename__ = "reminders"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    text = Column(String, nullable=False)
    remind_at = Column(DateTime, nullable=False)
    created_at = Column(DateTime, server_default=func.now())


class EmailDraft(Base):
    __tablename__ = "email_drafts"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    to_addr = Column(String, nullable=False, default="")
    subject = Column(String, nullable=False, default="")
    body = Column(String, nullable=False, default="")
    status = Column(String, nullable=False, default="pending")
    created_at = Column(DateTime, server_default=func.now())


class OAuthToken(Base):
    __tablename__ = "oauth_tokens"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    provider = Column(String, nullable=False)  # e.g. "google"
    access_token = Column(String, nullable=False, default="")
    refresh_token = Column(String, nullable=False, default="")
    expiry = Column(DateTime, nullable=True)
    __table_args__ = (UniqueConstraint("user_id", "provider", name="uq_user_provider"),)


class GoogleToken(Base):
    __tablename__ = "google_tokens"
    user_id = Column(Integer, ForeignKey("users.id"), primary_key=True)
    access_token = Column(String)
    refresh_token = Column(String)
    expiry = Column(DateTime)
    scope = Column(String, default="")


class SpotifyToken(Base):
    __tablename__ = "spotify_tokens"
    user_id = Column(Integer, ForeignKey("users.id"), primary_key=True)
    access_token = Column(String)
    refresh_token = Column(String)
    expiry = Column(DateTime)


class Memory(Base):
    __tablename__ = "memories"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    text = Column(String, nullable=False)
    created_at = Column(DateTime, server_default=func.now())


class OutlookToken(Base):
    __tablename__ = "outlook_tokens"
    user_id = Column(Integer, ForeignKey("users.id"), primary_key=True)
    access_token = Column(String)
    refresh_token = Column(String)
    expiry = Column(DateTime)


class UsageLog(Base):
    __tablename__ = "usage_logs"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    provider = Column(String)
    model = Column(String)
    input_tokens = Column(Integer, default=0)
    output_tokens = Column(Integer, default=0)
    created_at = Column(DateTime, server_default=func.now())


class ContentDraft(Base):
    __tablename__ = "content_drafts"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    topic = Column(String)
    platforms = Column(String)
    content = Column(String)
    status = Column(String, default="draft")
    created_at = Column(DateTime, server_default=func.now())


# ---------------------------------------------------------------------------
# Campus data (TTU summer app). Admin-entered, refreshed every semester.
# Each row carries `semester` (so old data can be filtered/cleared) and
# `updated_at` (a trust stamp students/admins can see). Offices/buildings are
# stored as free text because the admin retypes them each term.
# ---------------------------------------------------------------------------

class Building(Base):
    __tablename__ = "buildings"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    code = Column(String, nullable=False, default="")      # e.g. "ENGR"
    address = Column(String, nullable=False, default="")
    description = Column(String, nullable=False, default="")
    hours_text = Column(String, nullable=False, default="")
    semester = Column(String, nullable=False, default="")
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class Professor(Base):
    __tablename__ = "professors"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    email = Column(String, nullable=False, default="")
    department = Column(String, nullable=False, default="")
    office_building = Column(String, nullable=False, default="")
    office_number = Column(String, nullable=False, default="")
    office_hours = Column(String, nullable=False, default="")        # e.g. "Mon/Wed 2-4pm"
    office_hours_policy = Column(String, nullable=False, default="")  # e.g. "drop-in" / "by appointment"
    semester = Column(String, nullable=False, default="")
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class Advisor(Base):
    __tablename__ = "advisors"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    email = Column(String, nullable=False, default="")
    department = Column(String, nullable=False, default="")
    office_building = Column(String, nullable=False, default="")
    office_number = Column(String, nullable=False, default="")
    schedule = Column(String, nullable=False, default="")        # working schedule
    availability = Column(String, nullable=False, default="")    # how/when to reach them
    semester = Column(String, nullable=False, default="")
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class CourseSection(Base):
    """A single offered section for a term. Mirrors the registrar export columns:
    CRN | SUBJECT | COURSE | SECTION | TITLE | PERMIT? | DAYS | TIMES |
    START | END | CAMPUS | BUILDING | ROOM | INSTRUCTOR | MAX ENROLL."""
    __tablename__ = "course_sections"
    id = Column(Integer, primary_key=True, index=True)
    crn = Column(String, nullable=False, default="", index=True)  # registration number
    subject = Column(String, nullable=False, default="")          # e.g. "ECE"
    course = Column(String, nullable=False, default="")           # e.g. "3306"
    section = Column(String, nullable=False, default="")          # e.g. "201" / "D11"
    title = Column(String, nullable=False, default="")
    prerequisites = Column(String, nullable=False, default="")    # parsed from title parens
    permit_required = Column(String, nullable=False, default="")  # free text, may carry instructions
    days = Column(String, nullable=False, default="")             # e.g. "MTWRF" (blank for distance)
    times = Column(String, nullable=False, default="")
    start_date = Column(String, nullable=False, default="")
    end_date = Column(String, nullable=False, default="")
    campus = Column(String, nullable=False, default="")
    building = Column(String, nullable=False, default="")
    room_number = Column(String, nullable=False, default="")
    instructor = Column(String, nullable=False, default="")
    max_enroll = Column(Integer, nullable=False, default=0)
    is_graduate = Column(Boolean, nullable=False, default=False)  # green-highlighted grad courses
    semester = Column(String, nullable=False, default="")
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class UserSecurity(Base):
    """Per-user multi-factor security state (Phase 2). One row per user, created
    lazily when they start enrolling. TOTP secret is stored as-is for dev — note
    to encrypt at rest in production."""
    __tablename__ = "user_security"
    user_id = Column(Integer, ForeignKey("users.id"), primary_key=True)
    totp_secret = Column(String, nullable=True)          # active base32 secret
    totp_pending = Column(String, nullable=True)         # secret mid-enrollment, not yet confirmed
    totp_enabled = Column(Boolean, nullable=False, default=False)
    recovery_codes = Column(String, nullable=False, default="[]")  # JSON list of hashed codes
    current_challenge = Column(String, nullable=True)    # transient WebAuthn challenge (2b)
    stepup_at = Column(DateTime, nullable=True)          # last successful step-up re-auth
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class WebAuthnCredential(Base):
    """A registered passkey / platform authenticator (Windows Hello, Touch ID)
    for a user (Phase 2b). Stored as base64url strings."""
    __tablename__ = "webauthn_credentials"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    credential_id = Column(String, nullable=False, index=True)
    public_key = Column(String, nullable=False)
    sign_count = Column(Integer, nullable=False, default=0)
    name = Column(String, nullable=False, default="")
    created_at = Column(DateTime, server_default=func.now())


class PendingChange(Base):
    """A proposed change awaiting center-admin approval (maker-checker).
    Nothing a non-center-admin edits goes live until a central admin approves
    the matching PendingChange. `payload` is JSON of the proposed fields (or, for
    op='import', the parsed offerings+catalog)."""
    __tablename__ = "pending_changes"
    id = Column(Integer, primary_key=True, index=True)
    proposer_id = Column(Integer, ForeignKey("users.id"))
    proposer_email = Column(String, nullable=False, default="")
    resource = Column(String, nullable=False)   # e.g. "buildings", "courses", "import"
    op = Column(String, nullable=False)          # create | update | delete | import
    target_id = Column(Integer, nullable=True)   # for update/delete
    payload = Column(String, nullable=False, default="{}")
    summary = Column(String, nullable=False, default="")
    status = Column(String, nullable=False, default="pending")  # pending | approved | rejected
    created_at = Column(DateTime, server_default=func.now())
    decided_at = Column(DateTime, nullable=True)
    decided_by = Column(String, nullable=False, default="")
    decision_note = Column(String, nullable=False, default="")


class AppSetting(Base):
    """Simple runtime key/value settings (e.g. the active ElevenLabs voice id)
    so the central admin can change them without editing .env or redeploying."""
    __tablename__ = "app_settings"
    key = Column(String, primary_key=True)
    value = Column(String, nullable=False, default="")


class AuditLog(Base):
    """Append-only record of everything that changes the system: proposals,
    approvals, rejections, direct changes, role assignments, and (Phase 2) logins.
    This is the central admin's 'knowledge of everything that happens.'"""
    __tablename__ = "audit_log"
    id = Column(Integer, primary_key=True, index=True)
    actor_id = Column(Integer, nullable=True)
    actor_email = Column(String, nullable=False, default="")
    action = Column(String, nullable=False)      # propose | approve | reject | change | assign_role | login
    summary = Column(String, nullable=False, default="")
    detail = Column(String, nullable=True)       # JSON
    created_at = Column(DateTime, server_default=func.now())


class ElectiveCatalog(Base):
    """Stable catalog/requirements reference (the 'MASTER LIST' sheet): which
    courses count as electives in each category, with prereqs. Not per-term."""
    __tablename__ = "elective_catalog"
    id = Column(Integer, primary_key=True, index=True)
    category = Column(String, nullable=False, default="")   # "ECE" / "CS/MATH" / "Group B Project Lab"
    code = Column(String, nullable=False, default="")       # e.g. "ECE 3306"
    title = Column(String, nullable=False, default="")
    prerequisites = Column(String, nullable=False, default="")
    notes = Column(String, nullable=False, default="")
    catalog_year = Column(String, nullable=False, default="")  # e.g. "2025-2026"
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class Person(Base):
    """An auto-generated profile for any individual that appears in the campus
    data — professor, advisor, tutor, officer, or course instructor. Built by
    scanning the data (`app/people.py`); the admin can then enrich it (photo,
    bio, extra info). `name_key` is a normalized name used to de-duplicate and to
    link a person to the courses they teach."""
    __tablename__ = "people"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False, default="")
    name_key = Column(String, nullable=False, default="", index=True)
    role_label = Column(String, nullable=False, default="")   # Professor / Advisor / Tutor / Officer / Instructor
    department = Column(String, nullable=False, default="")
    email = Column(String, nullable=False, default="")
    office_building = Column(String, nullable=False, default="")
    office_number = Column(String, nullable=False, default="")
    office_hours = Column(String, nullable=False, default="")
    schedule = Column(String, nullable=False, default="")
    availability = Column(String, nullable=False, default="")
    photo_url = Column(String, nullable=False, default="")     # admin pastes a headshot link
    bio = Column(String, nullable=False, default="")
    extra_json = Column(String, nullable=False, default="{}")  # arbitrary extra fields admin adds
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class TutorAvailability(Base):
    """A tutor's or student-officer's (e.g. IEEE president) own availability,
    self-maintained but published to the kiosk only after center-admin approval.
    Linked to the owning user so each contributor can edit only their own."""
    __tablename__ = "tutor_availability"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    name = Column(String, nullable=False, default="")
    role_label = Column(String, nullable=False, default="")   # e.g. "Tutor" / "IEEE President"
    subjects = Column(String, nullable=False, default="")     # what they tutor / their focus
    location = Column(String, nullable=False, default="")
    schedule = Column(String, nullable=False, default="")     # when they're available
    notes = Column(String, nullable=False, default="")
    semester = Column(String, nullable=False, default="")
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class CourseEmbedding(Base):
    """One semantic vector per course, for meaning-based ('vector') search.

    `vector` is the embedding stored as a JSON list of floats — portable across
    SQLite (dev) and Postgres (prod). `text_hash` lets us skip re-embedding a course
    whose text hasn't changed (embeddings cost an API call each). In production on
    Postgres you'd swap `vector` for a real pgvector `VECTOR(1536)` column and let
    the database do the nearest-neighbour search with the `<=>` operator; here the
    similarity is computed in Python (the dataset is ~100 courses)."""
    __tablename__ = "course_embeddings"
    id = Column(Integer, primary_key=True, index=True)
    code = Column(String, nullable=False, default="", index=True)  # canonical "ECE 3306"
    text = Column(String, nullable=False, default="")              # the doc that was embedded
    vector = Column(String, nullable=False, default="[]")          # JSON list[float]
    model = Column(String, nullable=False, default="")             # which embedding model produced it
    text_hash = Column(String, nullable=False, default="", index=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class ServiceHours(Base):
    """Generic facility/service availability — stockroom, labs, help desks, etc."""
    __tablename__ = "service_hours"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)               # e.g. "Chemistry Stockroom"
    location = Column(String, nullable=False, default="")
    hours_text = Column(String, nullable=False, default="")
    policy = Column(String, nullable=False, default="")
    semester = Column(String, nullable=False, default="")
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
