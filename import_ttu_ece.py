"""One-shot importer for public TTU ECE department web pages.

Pulls three public sources and loads them into Summer:
  1. Faculty roster + per-professor research/education/office
       https://www.depts.ttu.edu/ece/faculty/
  2. Full undergraduate course descriptions
       https://www.depts.ttu.edu/ece/undergrad/syllabi/  (+ catalog.ttu.edu pages)
  3. Undergraduate lab info (stockroom policies, lab structure)
       https://www.depts.ttu.edu/ece/undergrad/labs/...

Faculty land in the Professor directory table (structured lookups) AND, together
with the courses and lab pages, in the searchable Document store (free keyword
retrieval) so Summer can answer free-form questions like "who does RF research"
or "what is the stockroom checkout policy".

Re-runnable: it refreshes the ECE professors and replaces the three ECE documents
each time, so run it again whenever the department updates its site.

Usage:  python import_ttu_ece.py
"""
import json
import re
import sys
import time

import httpx

from app.database import SessionLocal
from app import models, docs_rag

UA = {"User-Agent": "Summer-TTU/1.0 (https://summer-ttu.fly.dev; deosgracius17@gmail.com)"}
BASE = "https://www.depts.ttu.edu"
FACULTY_URL = BASE + "/ece/faculty/"
SYLLABI_URL = BASE + "/ece/undergrad/syllabi/"
LAB_PAGES = [
    ("Stockroom Policies", BASE + "/ece/undergrad/labs/stockroom_policies.php"),
    ("Project Laboratory Structure", BASE + "/ece/undergrad/labs/lab_structure.php"),
]
DEPARTMENT = "Electrical & Computer Engineering"


def _get(client, url):
    r = client.get(url, timeout=25, follow_redirects=True)
    r.raise_for_status()
    return r.text


def _visible_text(html):
    t = re.sub(r"<script.*?</script>|<style.*?</style>", " ", html, flags=re.S | re.I)
    t = re.sub(r"<[^>]+>", " ", t)
    t = re.sub(r"&nbsp;", " ", t)
    t = re.sub(r"&amp;", "&", t)
    return re.sub(r"\s+", " ", t).strip()


def _cv_link(html):
    """Find a professor's CV/curriculum-vitae PDF link on their profile page.
    Returns an absolute URL, or '' if none is linked."""
    for m in re.finditer(r'<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)</a>', html, re.S | re.I):
        href = m.group(1).strip()
        text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", m.group(2))).strip()
        if re.search(r"curriculum\s*vitae|\bcv\b", text, re.I) or re.search(r"vita|/cv[/.]", href, re.I):
            if href.lower().endswith(".pdf") or re.search(r"vita|curriculum", href, re.I):
                return (BASE + href) if href.startswith("/") else href
    return ""


def _section(text, label, stop_labels, maxlen=600):
    """Pull the run of text after `label` up to the next known heading."""
    i = text.find(label)
    if i < 0:
        return ""
    seg = text[i + len(label):]
    end = len(seg)
    for s in stop_labels:
        j = seg.find(s)
        if 0 < j < end:
            end = j
    return seg[:end].strip(" :-")[:maxlen]


# --------------------------------------------------------------------------- #
# 1. Faculty
# --------------------------------------------------------------------------- #
def import_faculty(db, client):
    html = _get(client, FACULTY_URL)
    start = html.find("bios:")
    br = html.find("[", start)
    depth, end = 0, -1
    for i in range(br, len(html)):
        if html[i] == "[":
            depth += 1
        elif html[i] == "]":
            depth -= 1
            if depth == 0:
                end = i
                break
    bios = json.loads(html[br:end + 1])
    print(f"  faculty roster: {len(bios)} records")

    STOPS = ["Personal Information", "Curriculum Vitae", "Education", "Interests",
             "Research", "Mailing Address", "Office", "Phone", "Email", "Fax",
             "Personal Website", "Follow Electrical", "Connect with Electrical",
             "Electrical & Computer Engineering Follow"]
    doc_parts = []
    refreshed = 0
    for i, b in enumerate(bios, 1):
        name = " ".join(x for x in [b.get("firstname"), b.get("middlename"),
                                    b.get("lastname")] if x and x != "None")
        name = re.sub(r"\s+", " ", name).strip()
        email = (b.get("email") or "").strip()
        jobtitle = (b.get("jobtitle") or "").strip()
        phone = (b.get("phone") or "").strip()

        office = interests = education = website = cv = ""
        path = b.get("fullpagepath") or ""
        if path:
            try:
                phtml = _get(client, BASE + path)
                ptext = _visible_text(phtml)
                office = _section(ptext, "Office", STOPS, 80)
                # Pull just the room code (e.g. "ECE 211", "ECE 206C") so stray
                # "Office Hours:" text or labels don't end up in the office field.
                mo = re.search(r"\b([A-Za-z]{2,4}\.?\s?\d{2,4}[A-Za-z]?)\b", office)
                office = mo.group(1).strip() if mo else ""
                interests = _section(ptext, "Interests", STOPS, 500)
                education = _section(ptext, "Education", STOPS, 500)
                website = _section(ptext, "Personal Website", STOPS, 150)
                cv = _cv_link(phtml)
                time.sleep(0.4)  # be polite to the server
            except Exception as e:
                print(f"    ! {name}: profile fetch failed ({e})")

        # Upsert into the Professor directory (match on email, else name).
        row = None
        if email:
            row = db.query(models.Professor).filter(models.Professor.email == email).first()
        if not row:
            row = db.query(models.Professor).filter(models.Professor.name == name).first()
        if not row:
            row = models.Professor(name=name)
            db.add(row)
        row.name = name
        row.email = email
        row.department = DEPARTMENT
        if jobtitle:
            row.title = jobtitle
        # Headshot: the roster JSON carries a site-relative photo path; store the
        # absolute URL so the kiosk can show it when a student asks about them.
        photo_src = (b.get("photo_src") or "").strip()
        if photo_src:
            row.photo_url = (BASE + photo_src) if photo_src.startswith("/") else photo_src
        if cv:
            row.cv_url = cv
        bio_parts = []
        if interests:
            bio_parts.append(f"Research interests: {interests}")
        if education:
            bio_parts.append(f"Education: {education}")
        if website:
            bio_parts.append(f"Website: {website}")
        if bio_parts:
            row.bio = "\n".join(bio_parts)
        # The scraped office string already includes the building (e.g. "ECE 211"),
        # so keep it whole in office_number and leave office_building blank to avoid
        # a doubled "ECE ECE 211".
        row.office_building = ""
        if office:
            row.office_number = office
        refreshed += 1

        block = [f"{name} — {jobtitle}".strip(" —")]
        if email:
            block.append(f"Email: {email}")
        if phone:
            block.append(f"Phone: {phone}")
        if office:
            block.append(f"Office: {office}")
        if interests:
            block.append(f"Research interests: {interests}")
        if education:
            block.append(f"Education: {education}")
        if website:
            block.append(f"Website: {website}")
        doc_parts.append("\n".join(block))
        print(f"    [{i}/{len(bios)}] {name}")

    db.commit()
    _replace_doc(db, "TTU ECE Faculty — Directory & Research", FACULTY_URL,
                 "\n\n".join(doc_parts))
    print(f"  professors refreshed: {refreshed}")


# --------------------------------------------------------------------------- #
# 2. Course descriptions
# --------------------------------------------------------------------------- #
def import_courses(db, client):
    html = _get(client, SYLLABI_URL)
    # Each course on the ECE listing: <a href="catalog...">ECE 1105</a> - Title
    # (The catalog.ttu.edu description pages themselves sit behind AWS WAF bot
    # protection and return an empty 202 to non-browser clients, so the full
    # paragraph descriptions can't be bulk-fetched. The ECE page gives us the
    # complete, official code+title list, which is what we store.)
    rows = re.findall(
        r'<a href="https://catalog\.ttu\.edu/[^"]+"[^>]*>\s*(ECE\s?\d{4})\s*</a>\s*-\s*([^<]+)',
        html)
    print(f"  course listing: {len(rows)} courses")
    parts = []
    for code, title in rows:
        code = re.sub(r"\s+", " ", code).strip()
        title = re.sub(r"\s+", " ", title.replace("&amp;", "&")).strip().rstrip(".")
        parts.append(f"{code} - {title}")
    header = ("Texas Tech University, Department of Electrical & Computer Engineering — "
              "complete undergraduate course list (course number and title):\n")
    _replace_doc(db, "TTU ECE Undergraduate Course List", SYLLABI_URL,
                 header + "\n".join(parts))


# --------------------------------------------------------------------------- #
# 3. Lab / stockroom pages
# --------------------------------------------------------------------------- #
def import_lab_docs(db, client):
    parts = []
    for label, url in LAB_PAGES:
        try:
            text = _visible_text(_get(client, url))
            # Trim the shared site chrome (nav) from the front if present.
            anchor = text.find(label)
            if anchor > 0:
                text = text[anchor:]
            parts.append(f"== {label} ==\nSource: {url}\n{text[:6000]}")
            print(f"    lab page: {label} ({len(text)} chars)")
        except Exception as e:
            print(f"    ! {label}: fetch failed ({e})")
    _replace_doc(db, "TTU ECE Undergraduate Labs — Stockroom & Structure",
                 LAB_PAGES[0][1], "\n\n".join(parts))


# --------------------------------------------------------------------------- #
def _replace_doc(db, title, source, text):
    """Delete any existing document with this title, then ingest fresh."""
    for d in db.query(models.Document).filter(models.Document.title == title).all():
        docs_rag.delete_document(db, d.id)
    if not (text or "").strip():
        print(f"  (skip empty document: {title})")
        return
    res = docs_rag.ingest_document(db, title=title, source=source, text=text)
    print(f"  document stored: {title} -> {res.get('chunks')} chunks, "
          f"embeddings_on={res.get('embeddings_on')}")


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    db = SessionLocal()
    try:
        with httpx.Client(headers=UA) as client:
            if which in ("all", "faculty"):
                print("Importing faculty...")
                import_faculty(db, client)
            if which in ("all", "courses"):
                print("Importing course descriptions...")
                import_courses(db, client)
            if which in ("all", "labs"):
                print("Importing lab/stockroom pages...")
                import_lab_docs(db, client)
        print("Done.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
