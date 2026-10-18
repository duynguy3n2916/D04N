"""Một khóa học gắn cho nhiều lớp: học sinh các lớp được gắn thấy khóa, lớp khác không; giáo viên chỉ gắn lớp mình phụ trách."""
from tests.conftest import token


def _ensure_class(client, admin, class_id):
    client.post("/ai/classes", headers=admin, json={"class_id": class_id, "name": f"Lớp {class_id}"})  # 409 nếu đã có


def _course(client, teacher, code):
    cid = client.post("/ai/courses", headers=teacher, json={"code": code, "title": "Khóa dùng chung", "class_id": "lop-a"}).json()["course_id"]
    return cid


def test_course_shared_across_classes(client, teacher, admin):
    _ensure_class(client, admin, "lop-b")
    cid = _course(client, teacher, "course-shared")

    # giáo viên lớp A không gắn được lớp B (không phụ trách)
    r = client.post(f"/ai/courses/{cid}/classes", headers=teacher, json={"class_id": "lop-b"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "CLASS_FORBIDDEN"

    # admin gắn lớp B: học sinh lớp B thấy khóa, lớp C vẫn không
    tree = client.post(f"/ai/courses/{cid}/classes", headers=admin, json={"class_id": "lop-b"})
    assert tree.status_code == 201 and tree.json()["class_ids"] == ["lop-a", "lop-b"]
    sv_b = token(client, "sv-shared-b", "student", ["lop-b"])
    sv_c = token(client, "sv-shared-c", "student", ["lop-c"])
    assert any(c["course_id"] == cid for c in client.get("/ai/learn/courses", headers=sv_b).json())
    assert all(c["course_id"] != cid for c in client.get("/ai/learn/courses", headers=sv_c).json())
    assert client.get(f"/ai/learn/courses/{cid}", headers=sv_b).status_code == 200
    assert client.get(f"/ai/learn/courses/{cid}", headers=sv_c).status_code == 404

    # giáo viên lớp B (phụ trách lớp B) thấy khóa trong danh sách quản lý
    gv_b = token(client, "gv-shared-b", "teacher", ["lop-b"])
    assert any(c["course_id"] == cid for c in client.get("/ai/courses", headers=gv_b).json())

    # gỡ lớp B; không gỡ được lớp chính
    r = client.delete(f"/ai/courses/{cid}/classes/lop-b", headers=admin)
    assert r.status_code == 200 and r.json()["class_ids"] == ["lop-a"]
    assert client.get(f"/ai/learn/courses/{cid}", headers=sv_b).status_code == 404
    r = client.delete(f"/ai/courses/{cid}/classes/lop-a", headers=admin)
    assert r.status_code == 409 and r.json()["error"]["code"] == "PRIMARY_CLASS"


def test_shared_course_lessons_and_submissions(client, teacher, admin, fake_llm):
    _ensure_class(client, admin, "lop-b")
    cid = _course(client, teacher, "course-shared2")
    client.post(f"/ai/courses/{cid}/classes", headers=admin, json={"class_id": "lop-b"})
    tree = client.post(f"/ai/courses/{cid}/chapters", headers=teacher, json={"title": "C1"}).json()
    ch = tree["chapters"][0]["chapter_id"]
    tree = client.post(f"/ai/chapters/{ch}/lessons", headers=teacher, json={"code": "lesson-shared2", "title": "B"}).json()
    lid = tree["chapters"][0]["lessons"][0]["lesson_id"]
    client.post(f"/ai/lessons/{lid}/items", headers=teacher, json={"type": "quiz", "title": "Kiểm tra", "count": 1, "pass_ratio": 0.5})
    # bài học của khóa dùng chung: học sinh lớp B vào được, lớp C không
    sv_b = token(client, "sv-shared2-b", "student", ["lop-b"])
    sv_c = token(client, "sv-shared2-c", "student", ["lop-c"])
    assert client.get(f"/ai/learn/lessons/{lid}", headers=sv_b).status_code == 200
    assert client.get(f"/ai/learn/lessons/{lid}", headers=sv_c).status_code == 404
    # bảng bài nộp của lớp B có bài kiểm tra của khóa dùng chung
    body = client.get("/ai/classes/lop-b/submissions", headers=admin).json()
    assert body["quizzes"] >= 1


def test_shared_course_documents_visible_to_linked_class(client, teacher, admin, fake_llm):
    from tests.conftest import LESSON_TEXT
    from tests.test_api_core import upload
    _ensure_class(client, admin, "lop-b")
    cid = _course(client, teacher, "course-shared3")
    client.post(f"/ai/courses/{cid}/classes", headers=admin, json={"class_id": "lop-b"})
    tree = client.post(f"/ai/courses/{cid}/chapters", headers=teacher, json={"title": "C1"}).json()
    ch = tree["chapters"][0]["chapter_id"]
    client.post(f"/ai/chapters/{ch}/lessons", headers=teacher, json={"code": "lesson-shared3", "title": "B"})
    # tài liệu nạp cho lớp chính lop-a, bài thuộc khóa dùng chung
    assert upload(client, teacher, "shared-bai.md", LESSON_TEXT, lesson_id="lesson-shared3", class_id="lop-a").status_code in (200, 201, 202)
    sv_b = token(client, "sv-shared3-b", "student", ["lop-b"])
    r = client.post("/ai/chat", headers=sv_b, json={"question": "Đóng gói là gì?", "lesson_id": "lesson-shared3"}).json()
    assert r["refused"] is False and r["sources"]
