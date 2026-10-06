"""Transcript, câu hỏi video, state machine, Question Agent, hint mode."""
import io
import threading
from datetime import timedelta

from app.core.utils import utcnow
from app.database import SessionLocal
from app.models.video_question import VideoQuestion
from app.models.workflow import VideoSession
from tests.conftest import SRT, token

VID = "vid-test"


def _import(client, teacher, srt=SRT, vid=VID):
    return client.post("/ai/videos/import-transcript", headers=teacher,
                       files={"file": ("a.srt", io.BytesIO(srt.encode()), "text/plain")},
                       data={"video_id": vid, "lesson_id": "lesson-video", "class_id": "lop-a"})


def _session_db(student_id, vid=VID):
    db = SessionLocal()
    s = db.query(VideoSession).filter_by(student_id=student_id, video_id=vid).one()
    return db, s


def test_transcript_import_versions_rollback(client, teacher):
    r = _import(client, teacher)
    assert r.status_code == 200, r.text
    assert r.json()["knowledge_base"]["status"] == "ready" and r.json()["version"] == 1
    tr = client.get(f"/ai/videos/{VID}/transcript", headers=teacher).json()
    assert tr["total_segments"] == 13
    segs = tr["segments"]
    segs[1]["text"] = "Đóng gói (encapsulation) là gom dữ liệu và phương thức vào lớp."
    r = client.put(f"/ai/videos/{VID}/transcript", headers=teacher, json={"segments": segs})
    assert r.json()["version"] == 2
    versions = client.get(f"/ai/videos/{VID}/transcript/versions", headers=teacher).json()
    assert [v["is_active"] for v in versions] == [True, False]
    docs = client.get("/ai/documents?source_type=video", headers=teacher).json()
    vdocs = [d for d in docs if d["source_id"] == VID]
    assert len(vdocs) == 1 and vdocs[0]["version"] == 2
    assert vdocs[0]["lesson_id"] == "lesson-video"  # kế thừa metadata khi sửa
    r = client.post(f"/ai/videos/{VID}/transcript/rollback/1", headers=teacher)
    assert r.json()["version"] == 3
    assert "encapsulation" not in client.get(f"/ai/videos/{VID}/transcript", headers=teacher).text
    # học sinh lớp khác không xem được
    sv_b = token(client, "sv-b2", "student", ["lop-b"])
    assert client.get(f"/ai/videos/{VID}/transcript", headers=sv_b).status_code == 404


def test_uploaded_video_transcription_is_available_to_player(client, teacher, monkeypatch):
    from app.services import transcription

    vid = "vid-auto-subtitles"
    monkeypatch.setattr(transcription, "transcribe_media", lambda *_args: [
        {"start_time": 1.0, "end_time": 3.0, "text": "Phụ đề tự tạo"},
    ])
    r = client.post("/ai/media/videos", headers=teacher,
                    files={"file": ("lesson.mp4", io.BytesIO(b"sample video"), "video/mp4")},
                    data={"video_id": vid, "class_id": "lop-a", "transcribe": "true"})
    assert r.status_code == 201, r.text
    assert r.json()["job_id"]

    job = client.get(f"/ai/media/videos/{vid}/transcription-job", headers=teacher)
    assert job.status_code == 200
    assert job.json()["job_id"] == r.json()["job_id"]
    assert job.json()["status"] == "succeeded"

    student = token(client, "sv-auto-subtitles", "student", ["lop-a"])
    transcript = client.get(f"/ai/videos/{vid}/transcript", headers=student)
    assert transcript.status_code == 200
    assert transcript.json()["segments"] == [
        {"start_time": 1.0, "end_time": 3.0, "text": "Phụ đề tự tạo"},
    ]


def test_teacher_video_questions_draft_flow(client, teacher, fake_llm):
    r = client.post(f"/ai/videos/{VID}/generate-question", headers=teacher, json={"timestamp": 30})
    assert r.status_code == 200, r.text
    q = r.json()
    assert q["status"] == "draft" and q["origin"] == "teacher" and q["correct_index"] == 1
    student = token(client, "sv-v", "student", ["lop-a"])
    player = client.get(f"/ai/videos/{VID}/questions", headers=student).json()
    assert q["question_id"] not in [x["question_id"] for x in player]
    r = client.patch(f"/ai/video-questions/{q['question_id']}", headers=teacher, json={"status": "approved",
                                                                                       "correct_index": 1})
    assert r.json()["status"] == "approved"
    player = client.get(f"/ai/videos/{VID}/questions", headers=student).json()
    item = next(x for x in player if x["question_id"] == q["question_id"])
    assert "answer" not in item and "correct_answer" not in item and "explanation" not in item

    r = client.post(f"/ai/videos/{VID}/suggest-timestamps", headers=teacher,
                    json={"max_suggestions": 2, "min_interval_seconds": 10})
    assert r.status_code == 200, r.text
    assert r.json()["total_suggestions"] >= 1 and r.json()["suggestions"][0]["status"] == "draft"
    manage = client.get(f"/ai/videos/{VID}/questions/manage", headers=teacher).json()
    assert {m["origin"] for m in manage} >= {"teacher", "ai_suggest"}


def _make_question(client, teacher, ts):
    r = client.post(f"/ai/videos/{VID}/questions", headers=teacher, json={
        "timestamp": ts, "question": "Đóng gói là gì?", "options": ["A. Kế thừa", "B. Gom dữ liệu và phương thức",
                                                                    "C. Đa hình", "D. Không có"],
        "correct_answer": "B", "explanation": "Định nghĩa đóng gói."})
    assert r.status_code == 200, r.text
    return r.json()["question_id"]


def test_full_interaction_cycle(client, teacher, fake_llm):
    qid = _make_question(client, teacher, 25)
    student = token(client, "sv-flow", "student", ["lop-a"])

    r = client.post("/ai/workflow/question-start", headers=student,
                    json={"video_id": VID, "question_id": qid, "current_time": 25})
    assert r.status_code == 200, r.text
    st = r.json()
    assert st["state"] == "WAITING_FOR_STUDENT" and st["deadline_remaining_seconds"] > 100
    assert st["active_question"]["question_id"] == qid and "answer" not in st["active_question"]
    # idempotent
    assert client.post("/ai/workflow/question-start", headers=student,
                       json={"video_id": VID, "question_id": qid}).status_code == 200

    # hint mode do server bật, bỏ qua cờ client; đáp án bị chặn
    fake_llm.push("hint", "Đáp án đúng là B nhé.")
    r = client.post("/ai/chat", headers=student, json={"question": "Đáp án câu này là gì?", "video_id": VID,
                                                      "video_time": 25, "video_question_active": False})
    assert r.json()["hint_mode"] is True
    assert "Đáp án đúng là B" not in r.json()["answer"]

    # chưa trả lời thì không resume, chưa hết giờ thì timeout bị từ chối
    assert client.post("/ai/workflow/resume", headers=student, json={"video_id": VID}).status_code == 409
    r = client.post("/ai/workflow/timeout", headers=student, json={"video_id": VID})
    assert r.status_code == 409 and r.json()["error"]["code"] == "TOO_EARLY"

    r = client.post(f"/ai/video-questions/{qid}/answer", headers=student, json={"selected_index": 1})
    body = r.json()
    assert body["is_correct"] is True and body["state"] == "TUTOR_FEEDBACK" and body["in_flow"] is True

    # sau khi trả lời: hết hint mode
    r = client.post("/ai/chat", headers=student, json={"question": "Đóng gói là gì?", "video_id": VID, "video_time": 25})
    assert r.json()["hint_mode"] is False

    r = client.post("/ai/workflow/resume", headers=student, json={"video_id": VID, "current_time": 26})
    assert r.json()["state"] == "COOLDOWN" and r.json()["remaining_cooldown_seconds"] > 200

    # Question Agent: trong cooldown thì không hỏi
    r = client.post("/ai/question-agent/trigger", headers=student, json={"video_id": VID, "current_time": 100})
    assert r.json()["triggered"] is False and r.json()["reason"] == "in_cooldown"

    db, s = _session_db("sv-flow")
    s.cooldown_until = utcnow() - timedelta(seconds=1)
    db.commit()
    db.close()
    # gần câu hỏi của giáo viên (25s) -> không hỏi
    r = client.post("/ai/question-agent/trigger", headers=student, json={"video_id": VID, "current_time": 40})
    assert r.json()["reason"] == "near_scheduled_question"
    r = client.post("/ai/question-agent/trigger", headers=student, json={"video_id": VID, "current_time": 110})
    body = r.json()
    assert body["triggered"] is True and body["state"] == "WAITING_FOR_STUDENT", body
    agent_qid = body["question"]["question_id"]
    # đang có câu hỏi -> không sinh câu thứ hai
    r = client.post("/ai/question-agent/trigger", headers=student, json={"video_id": VID, "current_time": 115})
    assert r.json()["reason"] == "interaction_in_progress"
    # câu hỏi agent không xuất hiện trong danh sách player
    assert agent_qid not in [x["question_id"] for x in client.get(f"/ai/videos/{VID}/questions", headers=student).json()]
    # học sinh khác không trả lời được câu agent của phiên này
    other = token(client, "sv-other2", "student", ["lop-a"])
    assert client.post(f"/ai/video-questions/{agent_qid}/answer", headers=other,
                       json={"selected_index": 0}).status_code == 403

    # hết hạn trả lời: server tự chuyển sang TUTOR_SELF_ANSWER
    db, s = _session_db("sv-flow")
    s.question_deadline_at = utcnow() - timedelta(seconds=1)
    db.commit()
    db.close()
    st = client.get(f"/ai/workflow/session?video_id={VID}", headers=student).json()
    assert st["state"] == "TUTOR_SELF_ANSWER" and st["last_result"]["type"] == "timeout"
    assert "Đáp án đúng" in st["last_result"]["feedback"]
    r = client.post(f"/ai/video-questions/{agent_qid}/answer", headers=student, json={"selected_index": 1})
    assert r.status_code == 409 and r.json()["error"]["code"] == "QUESTION_EXPIRED"
    # AI thứ hai: Tutor tự giải thích đáp án của câu Question Agent đặt ra (chạy nền sau khi commit)
    lr = client.get(f"/ai/workflow/session?video_id={VID}", headers=student).json()["last_result"]
    assert lr["tutor_status"] == "ready" and "[S1]" in lr["tutor_explanation"] and lr["tutor_sources"]
    kinds = [c["kind"] for c in fake_llm.calls]
    assert "agent" in kinds and "explain" in kinds
    explain_prompt = [c["user"] for c in fake_llm.calls if c["kind"] == "explain"][-1]
    assert "hết giờ" in explain_prompt and "<tai_lieu>" in explain_prompt
    reasons = [t["reason"] for t in st["transitions"]]
    assert "deadline_passed" in reasons and "agent_trigger" in reasons

    # câu hỏi GV tiếp theo khi đang xem feedback -> tự resume rồi mở câu mới
    r = client.post("/ai/workflow/question-start", headers=student, json={"video_id": VID, "question_id": qid})
    assert r.json()["state"] == "WAITING_FOR_STUDENT"


def test_agent_generation_failure_returns_to_playing(client, teacher, fake_llm):
    student = token(client, "sv-fail", "student", ["lop-a"])
    fake_llm.push("agent", RuntimeError("down"))
    r = client.post("/ai/question-agent/trigger", headers=student, json={"video_id": VID, "current_time": 110})
    assert r.json()["triggered"] is False and r.json()["reason"] == "generation_failed"
    assert r.json()["state"] == "VIDEO_PLAYING"


def test_agent_accepts_one_substantial_transcript_segment(client, teacher, fake_llm):
    vid = "vid-one-long-segment"
    words = "Hôm nay chúng ta học về tính đóng gói trong lập trình hướng đối tượng và cách bảo vệ dữ liệu của lớp."
    r = client.put(f"/ai/videos/{vid}/transcript", headers=teacher, json={"segments": [
        {"start_time": 0, "end_time": 90, "text": words},
    ]})
    assert r.status_code == 200, r.text
    student = token(client, "sv-one-segment", "student", ["lop-a"])
    r = client.post("/ai/question-agent/trigger", headers=student,
                    json={"video_id": vid, "current_time": 45})
    assert r.status_code == 200, r.text
    assert r.json()["triggered"] is True
    assert r.json()["question"]["origin"] == "agent"


def test_concurrent_triggers_create_single_question(client, teacher, fake_llm):
    student = token(client, "sv-race", "student", ["lop-a"])
    fake_llm.delay = 0.4
    results = []

    def go():
        results.append(client.post("/ai/question-agent/trigger", headers=student,
                                   json={"video_id": VID, "current_time": 110}).json())

    threads = [threading.Thread(target=go) for _ in range(4)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    fake_llm.delay = 0
    assert sum(1 for r in results if r["triggered"]) == 1, results
    db = SessionLocal()
    try:
        s = db.query(VideoSession).filter_by(student_id="sv-race", video_id=VID).one()
        n = db.query(VideoQuestion).filter(VideoQuestion.session_id == s.id).count()
        assert n == 1
    finally:
        db.close()


def test_open_question_llm_grading_and_fallback(client, teacher, fake_llm):
    r = client.post(f"/ai/videos/{VID}/questions", headers=teacher, json={
        "timestamp": 70, "type": "short_answer", "question": "Kế thừa giúp gì?",
        "correct_answer": "Tái sử dụng mã nguồn của lớp cha"})
    qid = r.json()["question_id"]
    student = token(client, "sv-open", "student", ["lop-a"])
    r = client.post(f"/ai/video-questions/{qid}/answer", headers=student, json={"student_answer": "Dùng lại code"})
    assert r.json()["verdict"] == "partial" and r.json()["in_flow"] is False
    fake_llm.push("grader", RuntimeError("x"))
    r = client.post(f"/ai/video-questions/{qid}/answer", headers=student, json={"student_answer": "abc"})
    assert r.status_code == 200 and r.json()["feedback_status"] == "fallback"


def test_sweeper_applies_timeout(client, teacher, fake_llm):
    from app.services.workflow import sweep_expired
    qid = _make_question(client, teacher, 90)
    student = token(client, "sv-sweep", "student", ["lop-a"])
    client.post("/ai/workflow/question-start", headers=student, json={"video_id": VID, "question_id": qid})
    db, s = _session_db("sv-sweep")
    s.question_deadline_at = utcnow() - timedelta(seconds=5)
    db.commit()
    assert sweep_expired(db) >= 1
    db.refresh(s)
    assert s.current_state == "TUTOR_SELF_ANSWER"
    db.close()


def test_wrong_answer_gets_tutor_explanation(client, teacher, fake_llm):
    qid = _make_question(client, teacher, 140)
    student = token(client, "sv-wrong", "student", ["lop-a"])
    client.post("/ai/workflow/question-start", headers=student, json={"video_id": VID, "question_id": qid, "current_time": 140})
    r = client.post(f"/ai/video-questions/{qid}/answer", headers=student, json={"selected_index": 0}).json()
    assert r["is_correct"] is False and r["tutor_status"] == "pending"
    lr = client.get(f"/ai/workflow/session?video_id={VID}", headers=student).json()["last_result"]
    assert lr["tutor_status"] == "ready" and lr["tutor_explanation"]
    assert "chưa đúng" in [c["user"] for c in fake_llm.calls if c["kind"] == "explain"][-1]
    # Tutor lỗi: luồng học không bị ảnh hưởng, chỉ đánh dấu failed
    qid2 = _make_question(client, teacher, 200)
    client.post("/ai/workflow/resume", headers=student, json={"video_id": VID})
    db, s = _session_db("sv-wrong")
    s.cooldown_until = utcnow() - timedelta(seconds=1)
    db.commit()
    db.close()
    client.post("/ai/workflow/question-start", headers=student, json={"video_id": VID, "question_id": qid2, "current_time": 200})
    fake_llm.push("explain", RuntimeError("LLM down"))
    r = client.post(f"/ai/video-questions/{qid2}/answer", headers=student, json={"selected_index": 2})
    assert r.status_code == 200
    lr = client.get(f"/ai/workflow/session?video_id={VID}", headers=student).json()["last_result"]
    assert lr["tutor_status"] == "failed" and lr["feedback"]
