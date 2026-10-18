"""Diễn đàn lớp: thành viên lớp, trả lời, khóa / ghim, đánh dấu câu đúng, quyền xóa, AI soạn nháp cho giáo viên."""
from tests.conftest import LESSON_TEXT, token
from tests.test_api_core import upload


def test_forum_membership_threads_and_replies(client, teacher):
    sv = token(client, "sv-forum-a", "student", ["lop-a"])
    other = token(client, "sv-forum-b", "student", ["lop-b"])

    r = client.post("/ai/forum/classes/lop-a/threads", headers=sv, json={"title": "Hỏi về đóng gói", "body": "Getter là gì?"})
    assert r.status_code == 201, r.text
    tid = r.json()["thread_id"]

    # người ngoài lớp không xem và không đăng được
    assert client.get("/ai/forum/classes/lop-a/threads", headers=other).status_code == 403
    assert client.post("/ai/forum/classes/lop-a/threads", headers=other, json={"title": "x", "body": "y"}).status_code == 403

    lst = client.get("/ai/forum/classes/lop-a/threads", headers=teacher).json()
    assert any(t["thread_id"] == tid and t["author_name"] for t in lst)

    rep = client.post(f"/ai/forum/threads/{tid}/replies", headers=teacher, json={"body": "Là hàm lấy giá trị thuộc tính."})
    assert rep.status_code == 201
    detail = client.get(f"/ai/forum/threads/{tid}", headers=sv).json()
    assert detail["reply_count"] == 1 and detail["replies"][0]["author_is_teacher"] is True
    assert detail["can_moderate"] is False


def test_lock_pin_and_accept(client, teacher):
    sv = token(client, "sv-forum-c", "student", ["lop-a"])
    t1 = client.post("/ai/forum/classes/lop-a/threads", headers=sv, json={"title": "Bài 1", "body": "a"}).json()["thread_id"]
    t2 = client.post("/ai/forum/classes/lop-a/threads", headers=sv, json={"title": "Bài 2", "body": "b"}).json()["thread_id"]

    # học sinh không ghim được; giáo viên ghim thì lên đầu danh sách
    assert client.patch(f"/ai/forum/threads/{t1}", headers=sv, json={"pinned": True}).status_code == 403
    assert client.patch(f"/ai/forum/threads/{t2}", headers=teacher, json={"pinned": True}).status_code == 200
    assert client.get("/ai/forum/classes/lop-a/threads", headers=sv).json()[0]["thread_id"] == t2

    # giáo viên khóa bài: học sinh không trả lời được, giáo viên vẫn trả lời được
    client.patch(f"/ai/forum/threads/{t1}", headers=teacher, json={"locked": True})
    assert client.post(f"/ai/forum/threads/{t1}/replies", headers=sv, json={"body": "thêm"}).status_code == 409
    rep = client.post(f"/ai/forum/threads/{t1}/replies", headers=teacher, json={"body": "đã khóa, đây là đáp án"}).json()

    # người đăng đánh dấu câu trả lời đúng
    client.patch(f"/ai/forum/threads/{t1}", headers=teacher, json={"locked": False})
    rep2 = client.post(f"/ai/forum/threads/{t1}/replies", headers=token(client, "sv-forum-d", "student", ["lop-a"]),
                       json={"body": "câu trả lời của bạn"}).json()
    assert client.post(f"/ai/forum/replies/{rep2['reply_id']}/accept", headers=sv).status_code == 200
    d = client.get(f"/ai/forum/threads/{t1}", headers=sv).json()
    assert d["has_answer"] is True and any(r["accepted"] and r["reply_id"] == rep2["reply_id"] for r in d["replies"])
    assert rep["reply_id"]  # giáo viên vẫn đăng được khi khóa


def test_delete_permissions(client, teacher):
    a = token(client, "sv-forum-e", "student", ["lop-a"])
    b = token(client, "sv-forum-f", "student", ["lop-a"])
    tid = client.post("/ai/forum/classes/lop-a/threads", headers=a, json={"title": "t", "body": "b"}).json()["thread_id"]
    rid = client.post(f"/ai/forum/threads/{tid}/replies", headers=a, json={"body": "r"}).json()["reply_id"]

    assert client.delete(f"/ai/forum/replies/{rid}", headers=b).status_code == 403
    assert client.delete(f"/ai/forum/replies/{rid}", headers=a).status_code == 204
    assert client.delete(f"/ai/forum/threads/{tid}", headers=b).status_code == 403
    assert client.delete(f"/ai/forum/threads/{tid}", headers=teacher).status_code == 204  # giáo viên xóa được bài của học sinh
    assert client.get(f"/ai/forum/threads/{tid}", headers=teacher).status_code == 404


def test_ai_draft_is_teacher_only_and_refuses_without_material(client, teacher, fake_llm):
    sv = token(client, "sv-forum-g", "student", ["lop-a"])
    tid = client.post("/ai/forum/classes/lop-a/threads", headers=sv,
                      json={"title": "Đóng gói", "body": "Đóng gói là gì?"}).json()["thread_id"]
    assert client.post(f"/ai/forum/threads/{tid}/ai-draft", headers=sv).status_code == 403

    # chưa có học liệu nào trong lớp này: không soạn nháp, báo rõ thay vì bịa
    other_tid = client.post("/ai/forum/classes/lop-b/threads", headers=token(client, "sv-forum-h", "student", ["lop-b"]),
                            json={"title": "Chủ đề lạ", "body": "xyz qqq"}).json()["thread_id"]
    gv_b = token(client, "gv-forum-b", "teacher", ["lop-b"])
    nd = client.post(f"/ai/forum/threads/{other_tid}/ai-draft", headers=gv_b).json()
    assert nd["draft"] is None and nd["refused"] is True

    # có học liệu của lớp: giáo viên nhận được bản nháp (chưa được đăng tự động)
    upload(client, teacher, "forum-bai.md", LESSON_TEXT, class_id="lop-a")
    d = client.post(f"/ai/forum/threads/{tid}/ai-draft", headers=teacher).json()
    assert d["draft"] and d["refused"] is False
    assert client.get(f"/ai/forum/threads/{tid}", headers=teacher).json()["reply_count"] == 0


def test_report_hide_and_dismiss(client, teacher):
    a = token(client, "sv-rp-a", "student", ["lop-a"])
    b = token(client, "sv-rp-b", "student", ["lop-a"])
    tid = client.post("/ai/forum/classes/lop-a/threads", headers=a, json={"title": "Nội dung xấu", "body": "spam"}).json()["thread_id"]
    rid = client.post(f"/ai/forum/threads/{tid}/replies", headers=a, json={"body": "spam nữa"}).json()["reply_id"]

    # không tự báo cáo mình; người khác báo cáo được, báo cáo trùng không tạo thêm
    assert client.post("/ai/forum/reports", headers=a, json={"thread_id": tid, "reason": "x"}).status_code == 400
    r1 = client.post("/ai/forum/reports", headers=b, json={"thread_id": tid, "reason": "Quảng cáo"}).json()
    assert r1["duplicate"] is False
    assert client.post("/ai/forum/reports", headers=b, json={"thread_id": tid, "reason": "lần 2"}).json()["duplicate"] is True
    client.post("/ai/forum/reports", headers=b, json={"reply_id": rid, "reason": "Spam"})

    # học sinh không xem được danh sách báo cáo; giáo viên thấy 2 báo cáo
    assert client.get("/ai/forum/classes/lop-a/reports", headers=b).status_code == 403
    reps = client.get("/ai/forum/classes/lop-a/reports", headers=teacher).json()
    mine = [x for x in reps if x["thread_id"] == tid]
    assert {x["kind"] for x in mine} == {"thread", "reply"}

    # ẩn câu trả lời: học sinh không thấy nữa, giáo viên vẫn thấy kèm cờ hidden
    rep_reply = next(x for x in mine if x["kind"] == "reply")
    assert client.post(f"/ai/forum/reports/{rep_reply['report_id']}/resolve", headers=teacher, json={"action": "hide"}).status_code == 200
    assert all(r["reply_id"] != rid for r in client.get(f"/ai/forum/threads/{tid}", headers=b).json()["replies"])
    assert any(r["reply_id"] == rid and r["hidden"] for r in client.get(f"/ai/forum/threads/{tid}", headers=teacher).json()["replies"])

    # bỏ qua báo cáo bài đăng: bài vẫn hiện; ẩn bài bằng tay thì học sinh nhận 404
    rep_thread = next(x for x in mine if x["kind"] == "thread")
    client.post(f"/ai/forum/reports/{rep_thread['report_id']}/resolve", headers=teacher, json={"action": "dismiss"})
    assert client.get(f"/ai/forum/threads/{tid}", headers=b).status_code == 200
    assert all(x["thread_id"] != tid for x in client.get("/ai/forum/classes/lop-a/reports", headers=teacher).json())
    client.patch(f"/ai/forum/threads/{tid}", headers=teacher, json={"hidden": True})
    assert client.get(f"/ai/forum/threads/{tid}", headers=b).status_code == 404
    assert all(t["thread_id"] != tid for t in client.get("/ai/forum/classes/lop-a/threads", headers=b).json())
    # hiện lại
    client.patch(f"/ai/forum/threads/{tid}", headers=teacher, json={"hidden": False})
    assert client.get(f"/ai/forum/threads/{tid}", headers=b).status_code == 200
