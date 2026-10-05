"""Đánh giá định lượng hệ thống RAG / Tutor.

Chỉ số:
- Retrieval: Hit@K, MRR, Recall@K so với nguồn đúng (ground truth) của từng câu hỏi.
- Trả lời: groundedness, correctness, context relevance (LLM-as-judge), tỷ lệ từ chối.
- Hệ thống: latency (trung bình, p50, p95), token, chi phí ước tính.
Mẫu lỗi (retrieval / LLM / judge) được đếm riêng và KHÔNG được gán điểm mặc định.
"""
import json
import statistics
import time
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.core.context import get_request_id
from app.core.errors import AppError
from app.core.llm_schemas import JudgeOutput
from app.core.prompts import EVAL_JUDGE, TUTOR_ANSWER, wrap_documents
from app.models.evaluation import AIEvaluation, EvalResult, EvalSample
from app.models.observability import AILLMCall
from app.services import jobs, llm
from app.services.retrieval import RetrievalScope, build_context, retrieve

TARGETS = {"hit_at_k": 0.85, "groundedness": 0.85, "latency_s": 5.0}
SAMPLE_FILE = Path(__file__).resolve().parents[2] / "sample_data" / "eval_samples.json"


# ----------------------------------------------------------------------------
# Quản lý bộ mẫu
# ----------------------------------------------------------------------------

def sample_to_dict(s: EvalSample) -> dict:
    return {"sample_id": str(s.id), "suite": s.suite, "external_id": s.external_id, "split": s.split,
            "question": s.question, "expected_answer": s.expected_answer, "relevant_sources": s.relevant_sources,
            "key_terms": s.key_terms, "course_id": s.course_id, "lesson_id": s.lesson_id,
            "answerable": s.answerable is not False}


def load_samples(db: Session, suite: str, samples: list[dict], replace: bool = False) -> int:
    if replace:
        db.query(EvalSample).filter(EvalSample.suite == suite).delete()
    n = 0
    for raw in samples:
        if not raw.get("question"):
            raise AppError(400, "INVALID_SAMPLE", "Mỗi mẫu cần trường question.")
        split = raw.get("split", "test")
        if split not in ("dev", "test"):
            raise AppError(400, "INVALID_SAMPLE", "split phải là dev hoặc test.")
        db.add(EvalSample(suite=suite, external_id=raw.get("id") or raw.get("external_id"), split=split,
                          question=raw["question"], expected_answer=raw.get("expected_answer"),
                          relevant_sources=raw.get("relevant_sources"), key_terms=raw.get("key_terms"),
                          course_id=raw.get("course_id"), lesson_id=raw.get("lesson_id"),
                          answerable=raw.get("answerable", True)))
        n += 1
    db.commit()
    return n


def load_default_samples(db: Session, suite: str = "default", replace: bool = True) -> int:
    data = json.loads(SAMPLE_FILE.read_text(encoding="utf-8"))
    return load_samples(db, suite, data["samples"], replace=replace)


# ----------------------------------------------------------------------------
# Đo
# ----------------------------------------------------------------------------

def _norm_title(t: str | None) -> str:
    t = (t or "").strip().lower()
    return t.rsplit(".", 1)[0] if "." in t[-6:] else t


def chunk_matches(chunk: dict, src: dict) -> bool:
    if src.get("video_id"):
        if chunk.get("source_type") != "video" or chunk.get("source_id") != src["video_id"]:
            return False
        s, e = src.get("start"), src.get("end")
        if s is None or e is None or chunk.get("start_time") is None:
            return True
        return chunk["start_time"] <= e and (chunk.get("end_time") or chunk["start_time"]) >= s
    title = src.get("document_title")
    if title and _norm_title(chunk.get("document_title")) != _norm_title(title):
        return False
    pages = src.get("pages")
    if pages and chunk.get("page") not in pages:
        return False
    sections = src.get("sections")
    if sections and (chunk.get("section") or "").strip().lower() not in [x.strip().lower() for x in sections]:
        return False
    return bool(title)


def retrieval_metrics(chunks: list[dict], sample: EvalSample) -> dict:
    sources = sample.relevant_sources or []
    if sources:
        rank = next((i + 1 for i, c in enumerate(chunks) if any(chunk_matches(c, s) for s in sources)), None)
        found = sum(1 for s in sources if any(chunk_matches(c, s) for c in chunks))
        return {"hit": rank is not None, "rank": rank, "recall": found / len(sources), "method": "ground_truth"}
    terms = [t.lower() for t in (sample.key_terms or [])]
    if terms:
        # cần >= một nửa số từ khóa xuất hiện trong cùng một chunk (chặt hơn 'bất kỳ từ nào')
        need = max(1, (len(terms) + 1) // 2)
        rank = next((i + 1 for i, c in enumerate(chunks)
                     if sum(t in c["content"].lower() for t in terms) >= need), None)
        return {"hit": rank is not None, "rank": rank, "recall": None, "method": "key_terms"}
    return {"hit": None, "rank": None, "recall": None, "method": "none"}


def _judge(question: str, context: str, expected: str | None, answer: str) -> JudgeOutput:
    prompt = (f"CÂU HỎI:\n{question}\n\nCONTEXT:\n{context[:6000]}\n\n"
              f"ĐÁP ÁN KỲ VỌNG:\n{expected or '(không có)'}\n\nCÂU TRẢ LỜI CỦA HỆ THỐNG:\n{answer}")
    out, _ = llm.complete_json("eval_judge", EVAL_JUDGE, prompt, JudgeOutput, max_tokens=500, temperature=0.0)
    return out


def _is_refusal(answer: str) -> bool:
    a = answer.lower()
    return any(p in a for p in ("chưa tìm thấy", "không tìm thấy", "không có thông tin", "không đủ thông tin"))


def _pct(values: list[float], q: float) -> float | None:
    if not values:
        return None
    vs = sorted(values)
    k = (len(vs) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(vs) - 1)
    return vs[lo] + (vs[hi] - vs[lo]) * (k - lo)


def _mean(values: list) -> float | None:
    vals = [v for v in values if v is not None]
    return round(statistics.fmean(vals), 4) if vals else None


@jobs.register("run_evaluation")
def run_evaluation_job(ctx: "jobs.JobContext", suite: str = "default", split: str = "test", top_k: int = 5,
                       use_judge: bool = True, created_by: str | None = None) -> dict:
    db = ctx.db
    q = db.query(EvalSample).filter(EvalSample.suite == suite)
    if split != "all":
        q = q.filter(EvalSample.split == split)
    samples = q.order_by(EvalSample.created_at, EvalSample.external_id).all()
    if not samples:
        raise AppError(400, "NO_SAMPLES", f"Bộ '{suite}' (split={split}) chưa có mẫu. Nạp mẫu qua /ai/evaluation/samples.")

    correlation = get_request_id()
    evaluation = AIEvaluation(test_suite_name=suite, split=split, total_samples=len(samples), hit_at_k=0.0,
                              groundedness_score=0.0, avg_latency_ms=0.0, created_by=created_by)
    db.add(evaluation)
    db.commit()

    rows: list[EvalResult] = []
    for i, s in enumerate(samples):
        ctx.progress(i / len(samples), f"Mẫu {i + 1}/{len(samples)}")
        r = EvalResult(evaluation_id=evaluation.id, sample_id=s.id, question=s.question, status="ok")
        try:
            t0 = time.perf_counter()
            scope = RetrievalScope(allowed_class_ids=None, course_id=s.course_id, lesson_id=s.lesson_id)
            ranked = retrieve(db, s.question, scope, top_k=top_k, min_score=0.0)
            r.retrieval_ms = (time.perf_counter() - t0) * 1000
            m = retrieval_metrics(ranked, s)
            r.hit, r.first_relevant_rank, r.recall, r.hit_method = m["hit"], m["rank"], m["recall"], m["method"]
            r.retrieved = [{"rank": k + 1, "title": c["document_title"], "page": c["page"],
                            "start_time": c["start_time"], "score": c["score"]} for k, c in enumerate(ranked)]
            usable = [c for c in ranked if (c["score"] or 0) >= settings.rag_min_score]
            if not usable:
                answer, context = "Mình chưa tìm thấy thông tin liên quan trong học liệu.", ""
                r.refused = True
            else:
                context, _ = build_context(usable)
                res = llm.complete_text("eval_answer", TUTOR_ANSWER,
                                        f"{wrap_documents(context)}\n\nCâu hỏi của học sinh: {s.question}",
                                        max_tokens=1200)
                answer = res.text.strip()
                r.refused = _is_refusal(answer)
            r.latency_ms = (time.perf_counter() - t0) * 1000
            r.answer = answer
        except Exception as e:
            r.status, r.error = "error", str(getattr(e, "detail", e))[:1000]
            rows.append(r)
            db.add(r)
            db.commit()
            continue
        if use_judge:
            if context:
                try:
                    j = _judge(s.question, context, s.expected_answer, answer)
                    r.groundedness, r.correctness, r.context_relevance = j.groundedness, j.correctness, j.context_relevance
                except Exception as e:
                    r.error = f"judge_failed: {str(getattr(e, 'detail', e))[:500]}"
            elif s.answerable is False:
                r.groundedness, r.correctness = 1.0, 1.0  # từ chối đúng với câu ngoài học liệu
        rows.append(r)
        db.add(r)
        db.commit()

    summary = _summarize(db, rows, samples, correlation, top_k, use_judge)
    report = _report_markdown(suite, split, top_k, summary)
    evaluation = db.get(AIEvaluation, evaluation.id)
    evaluation.error_count = summary["errors"]
    evaluation.hit_at_k = summary["hit_at_k"] or 0.0
    evaluation.groundedness_score = summary["groundedness"] or 0.0
    evaluation.avg_latency_ms = summary["latency_ms_avg"] or 0.0
    evaluation.metrics_summary = summary
    evaluation.config = summary["config"]
    evaluation.report_markdown = report
    db.commit()
    return {"evaluation_id": str(evaluation.id), **_headline(summary)}


def _headline(summary: dict) -> dict:
    return {k: summary[k] for k in ("total", "errors", "hit_at_k", "mrr", "groundedness", "correctness",
                                    "latency_ms_avg", "latency_ms_p95")}


def _summarize(db: Session, rows: list[EvalResult], samples: list[EvalSample], correlation: str, top_k: int,
               use_judge: bool) -> dict:
    by_id = {s.id: s for s in samples}
    ok = [r for r in rows if r.status == "ok"]
    answerable = [r for r in ok if by_id[r.sample_id].answerable is not False]
    unanswerable = [r for r in ok if by_id[r.sample_id].answerable is False]
    measured = [r for r in answerable if r.hit is not None]
    lat = [r.latency_ms for r in ok if r.latency_ms is not None]
    ret = [r.retrieval_ms for r in ok if r.retrieval_ms is not None]
    calls = db.query(func.count(AILLMCall.id), func.sum(AILLMCall.input_tokens), func.sum(AILLMCall.output_tokens),
                     func.sum(AILLMCall.cost_usd)).filter(AILLMCall.correlation_id == correlation).one()
    judged = [r for r in answerable if r.groundedness is not None]
    return {
        "total": len(rows),
        "errors": len(rows) - len(ok),
        "judge_failures": sum(1 for r in ok if (r.error or "").startswith("judge_failed")),
        "answerable": len(answerable),
        "unanswerable": len(unanswerable),
        "retrieval_measured": len(measured),
        "hit_methods": {m: sum(1 for r in measured if r.hit_method == m) for m in ("ground_truth", "key_terms")},
        "hit_at_k": round(sum(1 for r in measured if r.hit) / len(measured), 4) if measured else None,
        "mrr": round(sum(1 / r.first_relevant_rank for r in measured if r.first_relevant_rank) / len(measured), 4)
        if measured else None,
        "recall_at_k": _mean([r.recall for r in measured]),
        "groundedness": _mean([r.groundedness for r in judged]),
        "correctness": _mean([r.correctness for r in judged]),
        "context_relevance": _mean([r.context_relevance for r in judged]),
        "judged": len(judged),
        "false_refusal_rate": round(sum(1 for r in answerable if r.refused) / len(answerable), 4) if answerable else None,
        "correct_refusal_rate": round(sum(1 for r in unanswerable if r.refused) / len(unanswerable), 4)
        if unanswerable else None,
        "latency_ms_avg": round(statistics.fmean(lat), 1) if lat else None,
        "latency_ms_p50": round(_pct(lat, 0.5), 1) if lat else None,
        "latency_ms_p95": round(_pct(lat, 0.95), 1) if lat else None,
        "retrieval_ms_avg": round(statistics.fmean(ret), 1) if ret else None,
        "llm_calls": calls[0] or 0,
        "input_tokens": int(calls[1] or 0),
        "output_tokens": int(calls[2] or 0),
        "cost_usd": round(float(calls[3]), 4) if calls[3] is not None else None,
        "config": {
            "top_k": top_k, "rag_min_score": settings.rag_min_score, "llm_provider": settings.llm_provider,
            "llm_model": settings.current_llm_model(), "embedding_provider": settings.embedding_provider,
            "embedding_model": {"local": settings.embedding_model, "openai": settings.openai_embedding_model}
            .get(settings.embedding_provider, "hash (chỉ dùng kiểm thử)"), "embedding_dim": settings.embedding_dim,
            "chunk_size": 800, "chunk_overlap": 100, "judge": use_judge,
            "prompt_versions": {"answer": f"{TUTOR_ANSWER.id}:{TUTOR_ANSWER.version}",
                                "judge": f"{EVAL_JUDGE.id}:{EVAL_JUDGE.version}"},
        },
        "details": [{"question": r.question, "status": r.status, "hit": r.hit, "rank": r.first_relevant_rank,
                     "method": r.hit_method, "groundedness": r.groundedness, "correctness": r.correctness,
                     "refused": r.refused, "latency_ms": round(r.latency_ms, 1) if r.latency_ms else None,
                     "error": r.error, "answer_preview": (r.answer or "")[:200]} for r in rows],
    }


def _fmt_pct(v) -> str:
    return "N/A" if v is None else f"{v * 100:.1f}%"


def _verdict(v, target, higher_better=True) -> str:
    if v is None:
        return "Không đo được"
    ok = v >= target if higher_better else v < target
    return "Đạt" if ok else "Chưa đạt"


def _report_markdown(suite: str, split: str, top_k: int, m: dict) -> str:
    lat_s = m["latency_ms_avg"] / 1000 if m["latency_ms_avg"] is not None else None
    lat_text = f"{lat_s:.2f}s" if lat_s is not None else "N/A"
    p95_text = f"{m['latency_ms_p95'] / 1000:.2f}s" if m["latency_ms_p95"] is not None else "N/A"
    cfg = m["config"]
    lines = [
        "# Báo cáo đánh giá định lượng hệ thống AI",
        "",
        f"- **Bộ mẫu:** {suite} (split = {split})",
        f"- **Thời điểm:** {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}",
        f"- **Số mẫu:** {m['total']} (trả lời được: {m['answerable']}, ngoài học liệu: {m['unanswerable']}); "
        f"lỗi: {m['errors']}; judge lỗi: {m['judge_failures']}",
        "",
        "## 1. Chỉ số chính",
        "",
        "| Chỉ số | Kết quả | Mục tiêu | Đánh giá |",
        "|---|---:|---:|---|",
        f"| Retrieval Hit@{top_k} | {_fmt_pct(m['hit_at_k'])} | ≥ 85% | {_verdict(m['hit_at_k'], TARGETS['hit_at_k'])} |",
        f"| MRR | {m['mrr'] if m['mrr'] is not None else 'N/A'} | – | – |",
        f"| Recall@{top_k} (nguồn đúng) | {_fmt_pct(m['recall_at_k'])} | – | – |",
        f"| Groundedness | {_fmt_pct(m['groundedness'])} | ≥ 85% | {_verdict(m['groundedness'], TARGETS['groundedness'])} |",
        f"| Correctness | {_fmt_pct(m['correctness'])} | – | – |",
        f"| Context relevance | {_fmt_pct(m['context_relevance'])} | – | – |",
        f"| Từ chối sai (câu có trong học liệu) | {_fmt_pct(m['false_refusal_rate'])} | thấp | – |",
        f"| Từ chối đúng (câu ngoài học liệu) | {_fmt_pct(m['correct_refusal_rate'])} | cao | – |",
        f"| Latency trung bình | {lat_text} | < 5s | "
        f"{_verdict(lat_s, TARGETS['latency_s'], higher_better=False)} |",
        f"| Latency p95 | {p95_text} | – | – |",
        "",
        f"Token: {m['input_tokens']} vào / {m['output_tokens']} ra qua {m['llm_calls']} lượt gọi"
        + (f"; chi phí ước tính ${m['cost_usd']}" if m["cost_usd"] is not None else "; chưa cấu hình đơn giá để ước tính chi phí") + ".",
        "",
        "## 2. Cấu hình thí nghiệm",
        "",
        f"- LLM: {cfg['llm_provider']} / {cfg['llm_model']}; prompt {cfg['prompt_versions']['answer']}",
        f"- Embedding: {cfg['embedding_provider']} / {cfg['embedding_model']} ({cfg['embedding_dim']} chiều)",
        f"- Top-K = {cfg['top_k']}, ngưỡng similarity = {cfg['rag_min_score']}, chunk {cfg['chunk_size']} ký tự, overlap {cfg['chunk_overlap']}",
        f"- Groundedness / correctness chấm bằng LLM-as-judge ({cfg['prompt_versions']['judge']}).",
        "",
        "## 3. Nhận xét",
        "",
    ]
    notes = []
    if m["hit_at_k"] is not None:
        notes.append(f"- Retrieval tìm đúng nguồn trong top {top_k} ở {_fmt_pct(m['hit_at_k'])} số câu "
                     f"({m['hit_methods']['ground_truth']} câu chấm theo nguồn đúng, {m['hit_methods']['key_terms']} câu theo từ khóa).")
        if m["hit_at_k"] < TARGETS["hit_at_k"]:
            notes.append("- Hit@K chưa đạt mục tiêu: cân nhắc giảm kích thước chunk, đổi model embedding, "
                         "thêm hybrid search hoặc kiểm tra lại metadata lesson của tài liệu.")
    if m["groundedness"] is not None and m["groundedness"] < TARGETS["groundedness"]:
        notes.append("- Groundedness chưa đạt: xem các mẫu điểm thấp trong bảng chi tiết, siết prompt trả lời "
                     "hoặc tăng ngưỡng similarity để giảm context nhiễu.")
    if m["errors"]:
        notes.append(f"- Có {m['errors']} mẫu lỗi đã bị loại khỏi trung bình; cần chạy lại sau khi khắc phục.")
    if m["total"] < 50:
        notes.append(f"- Bộ mẫu mới có {m['total']} câu; kế hoạch yêu cầu 50–100 câu để kết quả có ý nghĩa thống kê.")
    notes.append("- Hạn chế: LLM-as-judge có thể thiên lệch; nên chấm thủ công lại khoảng 20% mẫu để đối chiếu.")
    lines += notes
    lines += ["", "## 4. Chi tiết từng mẫu", "", "| # | Câu hỏi | Hit | Rank | Grounded | Correct | Latency | Ghi chú |",
              "|---:|---|:---:|---:|---:|---:|---:|---|"]
    for i, d in enumerate(m["details"], 1):
        q = d["question"].replace("|", "/")[:70]
        hit = "–" if d["hit"] is None else ("✔" if d["hit"] else "✘")
        note = "lỗi: " + d["error"][:40] if d["status"] == "error" else ("từ chối" if d["refused"] else "")
        g = "–" if d["groundedness"] is None else f"{d['groundedness']:.2f}"
        c = "–" if d["correctness"] is None else f"{d['correctness']:.2f}"
        lt = "–" if d["latency_ms"] is None else f"{d['latency_ms'] / 1000:.2f}s"
        lines.append(f"| {i} | {q} | {hit} | {d['rank'] or '–'} | {g} | {c} | {lt} | {note} |")
    return "\n".join(lines)


def evaluation_to_dict(e: AIEvaluation) -> dict:
    summary = e.metrics_summary or {}
    return {"evaluation_id": str(e.id), "test_suite_name": e.test_suite_name, "split": e.split,
            "total_samples": e.total_samples, "error_count": e.error_count, "hit_at_5": e.hit_at_k,
            "hit_at_k": e.hit_at_k, "groundedness_score": e.groundedness_score, "avg_latency_ms": e.avg_latency_ms,
            "config": e.config, "metrics": {k: v for k, v in summary.items() if k != "details"},
            "details": summary.get("details"), "report_markdown": e.report_markdown,
            "created_at": e.created_at.isoformat() if e.created_at else None}


def word_error_rate(reference: str, hypothesis: str) -> dict:
    import re
    ref = re.findall(r"\w+", reference.lower())
    hyp = re.findall(r"\w+", hypothesis.lower())
    if not ref:
        raise AppError(400, "EMPTY_REFERENCE", "Văn bản chuẩn rỗng.")
    prev = list(range(len(hyp) + 1))
    for i in range(1, len(ref) + 1):
        cur = [i] + [0] * len(hyp)
        for j in range(1, len(hyp) + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ref[i - 1] != hyp[j - 1]))
        prev = cur
    return {"wer": round(prev[-1] / len(ref), 4), "edits": prev[-1], "reference_words": len(ref),
            "hypothesis_words": len(hyp)}
