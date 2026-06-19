from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session
from .. import models
from ..database import get_db
from ..auth import get_current_user
from ..agent import run_agent

router = APIRouter(prefix="/agent", tags=["agent"])


class AgentRequest(BaseModel):
    goal: str
    provider: str | None = None  # "openai" or "anthropic"; None = server default
    voice: bool = False


@router.post("")
async def agent(req: AgentRequest, db: Session = Depends(get_db),
                user: models.User = Depends(get_current_user)):
    try:
        return await run_agent(req.goal, db, user, provider=req.provider, voice=req.voice)
    except Exception as e:
        return {"reply": f"Agent error: {e}", "actions": []}
