from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.security import Principal, require_admin, require_teacher
from app.core.utils import parse_uuid
from app.database import get_db
from app.models.evaluation import AIEvaluation, EvalSample
from app.services import evaluation as ev
from app.services import jobs
from app.services.retrieval import active_transcript

router = APIRouter(prefix="/ai/evaluation", tags=["evaluation"])


class RunEvaluationRequest(BaseModel):
    test_suite_name: str = "default"
    split: str = Field(default="test", pattern="^(dev|test|all)$")
    top_k: int = Field(default=5, ge=1, le=10)
    use_judge: bool = True


@router.post("/run", status_code=202)
def run_evaluation(req: RunEvaluationRequest | None = None, user: Principal = Depends(require_admin),
                   db: Session = Depends(get_db)):
    """Chạy đánh giá nền. Theo dõi qua /ai/jobs/{job_id}; kết quả ở /ai/evaluation/latest."""
    req = req or RunEvaluationRequest()
    if not db.query(EvalSample.id).filter(EvalSample.suite == req.test_suite_name).first():
        raise AppError(400, "NO_SAMPLES", f"Bộ '{req.test_suite_name}' chưa có mẫu. Nạp mẫu trước (POST /ai/evaluation/samples).")
    job = jobs.submit(db, "run_evaluation", {"suite": req.test_suite_name, "split": req.split, "top_k": req.top_k,
                                             "use_judge": req.use_judge, "created_by": user.user_id},
                      created_by=user.user_id)
    return JSONResponse(status_code=202, content=jobs.job_to_dict(job))


@router.get("/latest")
def get_latest_evaluation(user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    record = db.query(AIEvaluation).order_by(AIEvaluation.created_at.desc()).first()
    if not record:
        raise AppError(404, "NOT_FOUND", "Chưa có lần đánh giá nào.")
    return ev.evaluation_to_dict(record)


@router.get("/runs")
def list_runs(user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    rows = db.query(AIEvaluation).order_by(AIEvaluation.created_at.desc()).limit(30).all()
    return [{k: v for k, v in ev.evaluation_to_dict(r).items() if k not in ("details", "report_markdown")} for r in rows]


@router.get("/runs/{evaluation_id}")
def get_run(evaluation_id: str, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    r = db.get(AIEvaluation, parse_uuid(evaluation_id, "evaluation_id"))
    if not r:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy lần đánh giá.")
    return ev.evaluation_to_dict(r)


@router.get("/runs/{evaluation_id}/report.md", response_class=PlainTextResponse)
def get_report(evaluation_id: str, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    r = db.get(AIEvaluation, parse_uuid(evaluation_id, "evaluation_id"))
    if not r:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy lần đánh giá.")
    return PlainTextResponse(r.report_markdown or "", media_type="text/markdown; charset=utf-8")


@router.get("/samples")
def list_samples(suite: str = "default", user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    rows = db.query(EvalSample).filter(EvalSample.suite == suite).order_by(EvalSample.created_at).all()
    return {"suite": suite, "total": len(rows), "samples": [ev.sample_to_dict(s) for s in rows]}


@router.get("/benchmark")
def get_benchmark_samples(user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    return list_samples("default", user, db)


class LoadSamplesRequest(BaseModel):
    suite: str = "default"
    replace: bool = False
    samples: list[dict] | None = None
    use_default_file: bool = False


@router.post("/samples")
def load_samples(req: LoadSamplesRequest, user: Principal = Depends(require_admin), db: Session = Depends(get_db)):
    """Nạp bộ câu hỏi chuẩn (JSON). use_default_file=true để nạp sample_data/eval_samples.json."""
    if req.use_default_file:
        n = ev.load_default_samples(db, req.suite, replace=req.replace)
    elif req.samples:
        n = ev.load_samples(db, req.suite, req.samples, replace=req.replace)
    else:
        raise AppError(400, "NO_SAMPLES", "Gửi danh sách samples hoặc use_default_file=true.")
    total = db.query(EvalSample).filter(EvalSample.suite == req.suite).count()
    return {"suite": req.suite, "loaded": n, "total": total}


class WerRequest(BaseModel):
    reference_text: str = Field(min_length=1)
    video_id: str | None = None
    hypothesis_text: str | None = None


@router.post("/wer")
def word_error_rate(req: WerRequest, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    """WER của transcript (đang active của video, hoặc văn bản truyền vào) so với bản chuẩn."""
    hyp = req.hypothesis_text
    if hyp is None:
        if not req.video_id:
            raise AppError(400, "BAD_REQUEST", "Cần video_id hoặc hypothesis_text.")
        tr = active_transcript(db, req.video_id)
        if not tr:
            raise AppError(404, "NO_TRANSCRIPT", "Video chưa có transcript.")
        hyp = " ".join(s.text for s in tr.segments)
    return ev.word_error_rate(req.reference_text, hyp)
