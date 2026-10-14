"""Xuất đề kiểm tra (DOCX / HTML, nhiều mã đề) và quên mật khẩu qua email."""
import io
import re
from urllib.parse import unquote

from docx import Document

from app.config import settings
from app.services import mailer, quiz_export
from tests.conftest import LESSON_TEXT, token
from tests.test_api_core import upload



def test_quiz_export_variants_remap_answers():
    p = {"type": "multiple_choice", "question": "Q?", "options": ["A. một", "B. hai", "C. ba", "D. bốn"],
         "correct_index": 2, "explanation": "vì ba"}
    tf = {"type": "true_false", "question": "Đúng không?", "options": ["Đúng", "Sai"], "correct_index": 1}
    for v in (1, 2, 3):
        qs = quiz_export.build_variant([p, tf], v, shuffle=True)
        mcq = next(q for q in qs if q.type == "multiple_choice")
        assert mcq.options[mcq.correct_index] == "ba"  # xáo lựa chọn nhưng đáp án vẫn đúng nội dung
        assert next(q for q in qs if q.type == "true_false").options == ["Đúng", "Sai"]
    # tất định: xuất lại cùng mã đề cho kết quả giống hệt
    assert quiz_export.build_variant([p, tf], 2, True)[0].question == quiz_export.build_variant([p, tf], 2, True)[0].question


def test_export_endpoint_docx_and_html(client, teacher, fake_llm):
    upload(client, teacher, "export.md", LESSON_TEXT, lesson_id="lesson-export", class_id="lop-a")
    gen = client.post("/ai/teacher/generate-quiz", headers=teacher,
                      json={"lesson_id": "lesson-export", "count": 3, "question_types": ["multiple_choice"]}).json()
    # chưa duyệt câu nào -> 404 rõ ràng
    r = client.get("/ai/teacher/question-bank/export?lesson_id=lesson-export", headers=teacher)
    assert r.status_code == 404 and r.json()["error"]["code"] == "NO_QUESTIONS"
    for q in gen["questions"]:
        client.patch(f"/ai/question-bank/{q['item_id']}", headers=teacher, json={"status": "approved"})

    r = client.get("/ai/teacher/question-bank/export?lesson_id=lesson-export&variants=2&duration=15", headers=teacher)
    assert r.status_code == 200, r.text
    assert "filename*=UTF-8''" in r.headers["content-disposition"]
    text = "\n".join(p.text for p in Document(io.BytesIO(r.content)).paragraphs)
    assert "Mã đề: 101" in text and "Mã đề: 102" in text and "ĐÁP ÁN" in text and "15 phút" in text
    assert text.count("Câu 1.") == 2

    r = client.get("/ai/teacher/question-bank/export?lesson_id=lesson-export&format=html&answers=false", headers=teacher)
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/html")
    assert "window.print()" in r.text and "ĐÁP ÁN" not in r.text and r.text.count('class="q"') == 3

    # học sinh không xuất được; giáo viên khác không thấy câu của người khác
    sv = token(client, "sv-export", "student", ["lop-a"])
    assert client.get("/ai/teacher/question-bank/export?lesson_id=lesson-export", headers=sv).status_code == 403
    other = token(client, "gv-other-export", "teacher", ["lop-a"])
    assert client.get("/ai/teacher/question-bank/export?lesson_id=lesson-export", headers=other).status_code == 404


def test_forgot_and_reset_password(client, admin, monkeypatch):
    sent: list[dict] = []
    monkeypatch.setattr(settings, "smtp_host", "smtp.test")
    monkeypatch.setattr(settings, "smtp_from", "no-reply@test")
    monkeypatch.setattr(mailer, "send_async", lambda to, subject, text, html=None: sent.append({"to": to, "text": text}))

    r = client.post("/ai/users", headers=admin, json={"username": "hs-quen-mk", "display_name": "Học sinh",
                                                      "email": "hs.quen@example.com", "password": "MatKhau@Cu1",
                                                      "role": "student", "must_change_password": False})
    assert r.status_code in (200, 201), r.text
    assert client.get("/ai/auth/config").json()["password_reset_email"] is True

    # tài khoản không tồn tại: cùng câu trả lời, không gửi gì
    generic = client.post("/ai/auth/forgot-password", json={"identifier": "khong-ton-tai"}).json()
    assert generic["ok"] and not sent
    r = client.post("/ai/auth/forgot-password", json={"identifier": "HS.QUEN@example.com"})
    assert r.json() == generic and len(sent) == 1 and sent[0]["to"] == "hs.quen@example.com"
    # gửi liên tục bị chặn (1 email / phút / tài khoản)
    client.post("/ai/auth/forgot-password", json={"identifier": "hs-quen-mk"})
    assert len(sent) == 1

    link = re.search(r"https?://\S+", sent[0]["text"]).group(0)
    assert "/#/reset-password?token=" in link
    reset_token = unquote(link.split("token=", 1)[1])
    # token đặt lại mật khẩu không dùng làm token đăng nhập được
    assert client.get("/ai/auth/me", headers={"Authorization": f"Bearer {reset_token}"}).status_code == 401
    old = client.post("/ai/auth/login", json={"username": "hs-quen-mk", "password": "MatKhau@Cu1"}).json()["access_token"]

    assert client.post("/ai/auth/reset-password", json={"token": reset_token, "new_password": "123"}).status_code == 400
    r = client.post("/ai/auth/reset-password", json={"token": reset_token, "new_password": "MatKhau@Moi2"})
    assert r.status_code == 200 and r.json()["access_token"]
    # link chỉ dùng được một lần; phiên cũ mất hiệu lực; mật khẩu mới đăng nhập được
    r = client.post("/ai/auth/reset-password", json={"token": reset_token, "new_password": "MatKhau@Moi3"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "INVALID_RESET_TOKEN"
    assert client.get("/ai/auth/me", headers={"Authorization": f"Bearer {old}"}).status_code == 401
    assert client.post("/ai/auth/login", json={"username": "hs-quen-mk", "password": "MatKhau@Moi2"}).status_code == 200


def test_forgot_password_disabled_without_smtp(client, monkeypatch):
    monkeypatch.setattr(settings, "smtp_host", "")
    assert client.get("/ai/auth/config").json()["password_reset_email"] is False
    r = client.post("/ai/auth/forgot-password", json={"identifier": "ai-do"})
    assert r.status_code == 503 and r.json()["error"]["code"] == "EMAIL_DISABLED"
