from datetime import datetime
from pydantic import BaseModel, ConfigDict


class UserCreate(BaseModel):
    email: str
    password: str
    role: str = "customer"
    timezone: str = "UTC"
    location: str = ""
    profile: dict = {}


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    email: str
    role: str
    timezone: str = "UTC"
    location: str = ""
    profile: dict = {}


class ProfileUpdate(BaseModel):
    timezone: str | None = None
    location: str | None = None
    profile: dict | None = None


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class TaskCreate(BaseModel):
    title: str


class TaskUpdate(BaseModel):
    title: str | None = None
    done: bool | None = None


class TaskOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    title: str
    done: bool
    created_at: datetime


# ---------------------------------------------------------------------------
# Campus data schemas (TTU summer app)
# ---------------------------------------------------------------------------

class BuildingIn(BaseModel):
    name: str
    code: str = ""
    address: str = ""
    description: str = ""
    hours_text: str = ""
    semester: str = ""


class BuildingOut(BuildingIn):
    model_config = ConfigDict(from_attributes=True)
    id: int
    updated_at: datetime | None = None


class ProfessorIn(BaseModel):
    name: str
    email: str = ""
    department: str = ""
    office_building: str = ""
    office_number: str = ""
    office_hours: str = ""
    office_hours_policy: str = ""
    semester: str = ""


class ProfessorOut(ProfessorIn):
    model_config = ConfigDict(from_attributes=True)
    id: int
    updated_at: datetime | None = None


class AdvisorIn(BaseModel):
    name: str
    email: str = ""
    department: str = ""
    office_building: str = ""
    office_number: str = ""
    schedule: str = ""
    availability: str = ""
    semester: str = ""


class AdvisorOut(AdvisorIn):
    model_config = ConfigDict(from_attributes=True)
    id: int
    updated_at: datetime | None = None


class CourseSectionIn(BaseModel):
    crn: str = ""
    subject: str = ""
    course: str = ""
    section: str = ""
    title: str = ""
    prerequisites: str = ""
    permit_required: str = ""
    days: str = ""
    times: str = ""
    start_date: str = ""
    end_date: str = ""
    campus: str = ""
    building: str = ""
    room_number: str = ""
    instructor: str = ""
    max_enroll: int = 0
    is_graduate: bool = False
    semester: str = ""


class CourseSectionOut(CourseSectionIn):
    model_config = ConfigDict(from_attributes=True)
    id: int
    updated_at: datetime | None = None


class AvailabilityIn(BaseModel):
    name: str = ""
    role_label: str = ""
    subjects: str = ""
    location: str = ""
    schedule: str = ""
    notes: str = ""
    semester: str = ""
    user_id: int = 0


class AvailabilityOut(AvailabilityIn):
    model_config = ConfigDict(from_attributes=True)
    id: int
    updated_at: datetime | None = None


class ElectiveCatalogIn(BaseModel):
    category: str = ""
    code: str = ""
    title: str = ""
    prerequisites: str = ""
    notes: str = ""
    catalog_year: str = ""


class ElectiveCatalogOut(ElectiveCatalogIn):
    model_config = ConfigDict(from_attributes=True)
    id: int
    updated_at: datetime | None = None


class ServiceHoursIn(BaseModel):
    name: str
    location: str = ""
    hours_text: str = ""
    policy: str = ""
    semester: str = ""


class ServiceHoursOut(ServiceHoursIn):
    model_config = ConfigDict(from_attributes=True)
    id: int
    updated_at: datetime | None = None
