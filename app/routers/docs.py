"""Reference-document RAG endpoints (admin only).

Admins upload department handbooks / policies / syllabi / FAQs here; the file is
chunked + embedded so the assistant (and kiosk) can answer from it with citations.
Uploads are admin-gated and audited; reading happens through the `search_documents`
agent tool, not these endpoints.
"""
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from sqlalchemy.orm import Session
from .. import models, audit, docs_rag
from ..database import get_db
from ..auth import require_roles

router = APIRouter(prefix="/docs", tags=["docs"])


@router.get("")
def list_docs(db: Session = Depends(get_db),
              actor: models.User = Depends(require_roles("admin"))):
    return {"documents": docs_rag.list_documents(db)}


@router.post("/upload")
async def upload_doc(
    file: UploadFile = File(...),
    title: str = Form(""),
    db: Session = Depends(get_db),
    actor: models.User = Depends(require_roles("admin")),
):
    """Upload a .txt/.md/.pdf reference document; it is chunked + embedded for RAG."""
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "The uploaded file is empty.")
    try:
        text, kind = docs_rag.extract_text(file.filename, raw)
    except ValueError as e:
        raise HTTPException(400, str(e))
    res = docs_rag.ingest_document(db, title.strip(), file.filename, text, kind)
    if res.get("error"):
        raise HTTPException(400, res["error"])
    audit.log(db, actor, "change", f"Upload document: {res['title']}",
              {"document_id": res["document_id"], "chunks": res["chunks"]})
    db.commit()
    return res


@router.delete("/{doc_id}")
def delete_doc(doc_id: int, db: Session = Depends(get_db),
               actor: models.User = Depends(require_roles("admin"))):
    if not docs_rag.delete_document(db, doc_id):
        raise HTTPException(404, "Document not found")
    audit.log(db, actor, "change", f"Delete document #{doc_id}", {"document_id": doc_id})
    db.commit()
    return {"deleted": doc_id}
