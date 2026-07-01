import os
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session
from .. import models, ratelimit
from ..database import get_db
from ..auth import get_current_user
from ..agent import run_agent, _granted_services_for
from ..welcome import compose_welcome
from .. import orchestrator

router = APIRouter(prefix="/agent", tags=["agent"])

# Per-user cost/abuse guard on the paid LLM endpoints (keyed by user id, so a stolen or
# runaway token can't rack up spend). Generous for a human; blocks a loop. Tunable via env.
AGENT_MAX = int(os.getenv("AGENT_PER_MIN", "40"))


@router.get("/welcome")
async def welcome(hour: int = -1, emails: int = 0, db: Session = Depends(get_db),
                  user: models.User = Depends(get_current_user)):
    """Spoken 'welcome back' briefing — gated on the 'daily_update' service
    (admins always; others only if the central admin granted it). `hour` is the
    client's local hour (0-23) so the time matches the user's clock, not the UTC
    server clock. `emails=1` returns the second phase (reading important emails),
    which the client requests only after the user says yes to the email offer."""
    is_admin = user.role in ("admin", "central_admin")
    if not is_admin and "daily_update" not in _granted_services_for(db, user.id):
        return {"text": "", "disabled": True}
    try:
        return await compose_welcome(db, user, hour, include_email=bool(emails))
    except Exception as e:
        # Log server-side; don't leak internal exception detail to the client.
        import logging
        logging.getLogger("summer").warning("welcome briefing failed: %s", e)
        return {"text": "Welcome back. I'm ready whenever you are."}


class AgentRequest(BaseModel):
    goal: str
    provider: str | None = None  # "openai" or "anthropic"; None = server default
    voice: bool = False


@router.post("")
async def agent(req: AgentRequest, db: Session = Depends(get_db),
                user: models.User = Depends(get_current_user)):
    ratelimit.check(f"agent:{user.id}", AGENT_MAX)
    try:
        return await run_agent(req.goal, db, user, provider=req.provider, voice=req.voice)
    except Exception as e:
        import logging
        logging.getLogger("summer").warning("agent run failed: %s", e)
        return {"reply": "Sorry — something went wrong on my end. Please try again.", "actions": []}


class OrchestrateRequest(BaseModel):
    question: str


@router.post("/orchestrate")
def orchestrate(req: OrchestrateRequest, db: Session = Depends(get_db),
                user: models.User = Depends(get_current_user)):
    """Run the multi-agent orchestrator (route -> retrieve -> synthesize -> validate,
    with a grounding-driven retry loop) and return the grounded answer + citations."""
    ratelimit.check(f"orchestrate:{user.id}", AGENT_MAX)
    try:
        return orchestrator.run_orchestrator(db, req.question)
    except Exception as e:
        import logging
        logging.getLogger("summer").warning("orchestrator failed: %s", e)
        return {"answer": "Sorry — something went wrong on my end. Please try again.",
                "grounded": False, "citations": []}
