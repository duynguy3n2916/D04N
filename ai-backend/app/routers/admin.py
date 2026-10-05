"""Quan sát hệ thống: thống kê lượt gọi LLM (latency, token, chi phí) theo tác vụ."""
from datetime import timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.security import Principal, require_admin
from app.core.utils import utcnow
from app.database import get_db
from app.models.observability import AILLMCall

router = APIRouter(prefix="/ai/admin", tags=["admin"])


@router.get("/llm-stats")
def llm_stats(hours: int = 24 * 7, user: Principal = Depends(require_admin), db: Session = Depends(get_db)):
    since = utcnow() - timedelta(hours=hours)
    p95 = func.percentile_cont(0.95).within_group(AILLMCall.latency_ms)
    p50 = func.percentile_cont(0.5).within_group(AILLMCall.latency_ms)
    rows = (db.query(AILLMCall.task, func.count(), func.count().filter(AILLMCall.status != "ok"),
                     p50, p95, func.sum(AILLMCall.input_tokens), func.sum(AILLMCall.output_tokens),
                     func.sum(AILLMCall.cost_usd))
            .filter(AILLMCall.created_at >= since).group_by(AILLMCall.task).order_by(AILLMCall.task).all())
    return {"since": since.isoformat(), "tasks": [
        {"task": t, "calls": n, "failed": int(f or 0), "latency_ms_p50": round(a or 0, 1), "latency_ms_p95": round(b or 0, 1),
         "input_tokens": int(i or 0), "output_tokens": int(o or 0), "cost_usd": round(c, 4) if c is not None else None}
        for t, n, f, a, b, i, o, c in rows]}


@router.get("/llm-calls")
def recent_llm_calls(limit: int = 50, user: Principal = Depends(require_admin), db: Session = Depends(get_db)):
    rows = db.query(AILLMCall).order_by(AILLMCall.created_at.desc()).limit(min(limit, 200)).all()
    return [{"id": str(r.id), "task": r.task, "prompt": f"{r.prompt_id}:{r.prompt_version}", "model": r.model,
             "status": r.status, "attempt": r.attempt, "latency_ms": round(r.latency_ms or 0, 1),
             "input_tokens": r.input_tokens, "output_tokens": r.output_tokens, "cost_usd": r.cost_usd,
             "correlation_id": r.correlation_id, "error": r.error,
             "created_at": r.created_at.isoformat() if r.created_at else None} for r in rows]
