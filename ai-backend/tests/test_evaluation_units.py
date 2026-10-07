"""Evaluation + các hàm thuần."""
import json

import pytest

from app.core.llm_schemas import AgentQuestionItem, QuestionItem, schema_hint
from app.core.utils import resolve_option_index
from app.services.chunking import chunk_text
from app.services.evaluation import chunk_matches, word_error_rate
from app.services.transcription import group_segments, parse_transcript_content


def test_resolve_option_index():
    opts = ["A. Một", "B. Hai", "C. Ba", "D. Bốn"]
    assert resolve_option_index(opts, "B") == 1
    assert resolve_option_index(opts, "b.") == 1
    assert resolve_option_index(opts, "C. Ba") == 2
    assert resolve_option_index(opts, "Bốn") == 3
    assert resolve_option_index(opts, "Năm") is None
    assert resolve_option_index(["Đúng", "Sai"], "Sai") == 1


def test_question_schema():
    q = QuestionItem(type="true_false", question="OOP có 4 tính chất?", correct_answer="Đúng")
    assert q.options == ["Đúng", "Sai"] and q.correct_index == 0
    with pytest.raises(ValueError):
        QuestionItem(type="multiple_choice", question="Câu hỏi?", options=["A. x", "B. y"], correct_answer="A")
    with pytest.raises(ValueError):
        QuestionItem(type="multiple_choice", question="Câu hỏi?", options=["A. x", "B. y", "C. z", "D. t"],
                     correct_answer="E")
    assert QuestionItem(type="essay", question="Trình bày OOP", options=["x"], correct_answer="...").options is None


def test_agent_schema_hint_has_valid_choices():
    example = json.loads(schema_hint(AgentQuestionItem).split("\n", 1)[1])
    example["question"] = "Câu hỏi về đoạn vừa xem?"
    question = AgentQuestionItem.model_validate(example)
    assert len(question.options) == 4 and question.correct_index == 1


def test_chunking_overlap_and_long_paragraph():
    text = "Câu một rất dài. " * 120
    chunks = chunk_text(text, chunk_size=300, overlap=50)
    assert len(chunks) > 3 and all(len(c["content"]) <= 300 for c in chunks)


def test_transcript_parsers():
    vtt = "WEBVTT\n\n00:01.000 --> 00:04.500 align:start\n<i>Xin chào</i>\n\n01:00:00.000 --> 01:00:02.000\nCuối"
    segs = parse_transcript_content(vtt, "a.vtt")
    assert segs[0] == {"start_time": 1.0, "end_time": 4.5, "text": "Xin chào"} and segs[1]["start_time"] == 3600
    js = '{"segments": [{"start": 1, "duration": 2, "text": "a"}, {"start": 5, "text": "b"}]}'
    assert parse_transcript_content(js, "x.json")[0]["end_time"] == 3
    groups = group_segments([{"start_time": i, "end_time": i + 1, "text": "x" * 200} for i in range(10)])
    assert groups[0]["segment_to"] == groups[1]["segment_from"]  # overlap 1 segment
    assert groups[-1]["segment_to"] == 9


def test_chunk_matching_and_wer():
    c = {"document_title": "Bài 1: OOP", "page": None, "section": "Tính kế thừa", "source_type": "lesson"}
    assert chunk_matches(c, {"document_title": "Bài 1: OOP", "sections": ["tính kế thừa"]})
    assert not chunk_matches(c, {"document_title": "Bài 1: OOP", "sections": ["Tính đa hình"]})
    v = {"source_type": "video", "source_id": "v1", "start_time": 100, "end_time": 130}
    assert chunk_matches(v, {"video_id": "v1", "start": 120, "end": 200})
    assert not chunk_matches(v, {"video_id": "v1", "start": 140, "end": 200})
    assert word_error_rate("xin chào các em", "xin chào cả em")["wer"] == 0.25


def test_evaluation_run_is_honest(client, admin, teacher, fake_llm):
    samples = [
        {"id": "e1", "question": "Đóng gói là gì?", "expected_answer": "Gom dữ liệu và phương thức",
         "relevant_sources": [{"document_title": "bai-dong-goi.md", "sections": ["Tính đóng gói"]}]},
        {"id": "e2", "question": "Kế thừa là gì?", "expected_answer": "Lớp con dùng lại lớp cha",
         "relevant_sources": [{"document_title": "bai-dong-goi.md", "sections": ["Tính kế thừa"]}]},
        {"id": "e3", "question": "Thủ đô của Pháp?", "answerable": False},
        {"id": "e4", "split": "dev", "question": "Đa hình là gì?", "key_terms": ["đa hình", "hành vi"]},
    ]
    assert client.post("/ai/evaluation/samples", headers=teacher, json={"suite": "t", "samples": samples}).status_code == 403
    r = client.post("/ai/evaluation/samples", headers=admin, json={"suite": "t", "samples": samples, "replace": True})
    assert r.json()["loaded"] == 4
    # judge lỗi ở mẫu đầu tiên: không được gán điểm mặc định
    fake_llm.push("judge", RuntimeError("judge down"))
    r = client.post("/ai/evaluation/run", headers=admin, json={"test_suite_name": "t", "split": "all"})
    assert r.status_code == 202, r.text
    job = r.json()
    assert job["status"] == "succeeded", job
    latest = client.get("/ai/evaluation/latest", headers=teacher).json()
    m = latest["metrics"]
    assert m["total"] == 4 and m["errors"] == 0 and m["judge_failures"] == 1
    assert m["judged"] == 2  # 3 câu có trong học liệu, 1 judge lỗi -> 2 câu được chấm
    assert m["groundedness"] == pytest.approx(0.9)
    assert m["retrieval_measured"] == 3 and m["hit_methods"]["ground_truth"] == 2
    assert m["correct_refusal_rate"] is not None
    assert m["llm_calls"] > 0 and m["input_tokens"] > 0
    assert "Cấu hình thí nghiệm" in latest["report_markdown"]
    assert "50–100" in latest["report_markdown"]
    rep = client.get(f"/ai/evaluation/runs/{latest['evaluation_id']}/report.md", headers=teacher)
    assert rep.status_code == 200 and rep.text.startswith("# Báo cáo")
