"""Lộ trình học: khóa học → chương → bài → mục; khóa mục, hoàn thành + XP, quiz cuối bài, media."""
from tests.conftest import LESSON_TEXT, token


def _build_course(client, teacher):
    r = client.post("/ai/courses", headers=teacher,
                    json={"code": "course-learn", "title": "Khóa thử", "class_id": "lop-a"})
    assert r.status_code == 200, r.text
    cid = r.json()["course_id"]
    tree = client.post(f"/ai/courses/{cid}/chapters", headers=teacher, json={"title": "Chương 1"}).json()
    ch = tree["chapters"][0]["chapter_id"]
    tree = client.post(f"/ai/chapters/{ch}/lessons", headers=teacher,
                       json={"code": "lesson-learn", "title": "Bài 1"}).json()
    lid = tree["chapters"][0]["lessons"][0]["lesson_id"]
    # video (tải file nhỏ), bài đọc, quiz
    r = client.post("/ai/media/videos", headers=teacher, data={"video_id": "vid-learn", "title": "Video 1", "class_id": "lop-a"},
                    files={"file": ("v.mp4", b"\x00" * 4096, "video/mp4")})
    assert r.status_code == 201, r.text
    client.post(f"/ai/lessons/{lid}/items", headers=teacher, json={"type": "video", "title": "Video 1", "video_id": "vid-learn"})
    client.post(f"/ai/lessons/{lid}/items", headers=teacher, json={"type": "reading", "title": "Bài đọc", "content_md": LESSON_TEXT})
    tree = client.post(f"/ai/lessons/{lid}/items", headers=teacher,
                       json={"type": "quiz", "title": "Kiểm tra", "count": 2, "pass_ratio": 0.5}).json()
    items = tree["chapters"][0]["lessons"][0]["items"]
    assert [i["type"] for i in items] == ["video", "reading", "quiz"]
    return cid, lid, items


def test_course_path_completion_xp_and_quiz(client, teacher, fake_llm):
    cid, lid, items = _build_course(client, teacher)
    video, reading, quiz = (i["item_id"] for i in items)

    # học sinh lớp khác không thấy khóa học
    other = token(client, "sv-khac", "student", ["lop-b"])
    assert all(c["course_id"] != cid for c in client.get("/ai/learn/courses", headers=other).json())
    assert client.get(f"/ai/learn/courses/{cid}", headers=other).status_code == 404

    sv = token(client, "sv-learn", "student", ["lop-a"])
    tree = client.get(f"/ai/learn/courses/{cid}", headers=sv).json()
    st = [i["status"] for i in tree["chapters"][0]["lessons"][0]["items"]]
    assert st == ["current", "locked", "locked"]
    r = client.get(f"/ai/learn/items/{reading}", headers=sv)
    assert r.status_code == 403 and r.json()["error"]["code"] == "ITEM_LOCKED"
    assert client.post(f"/ai/learn/items/{reading}/complete", headers=sv).status_code == 403

    d = client.get(f"/ai/learn/items/{video}", headers=sv).json()
    assert d["video"]["stream_path"] == "/ai/media/videos/vid-learn/file"
    # phát video: Range + token qua query (thẻ <video> không gửi header được)
    tok = sv["Authorization"].split()[1]
    r = client.get(f"/ai/media/videos/vid-learn/file?access_token={tok}", headers={"Range": "bytes=0-99"})
    assert r.status_code == 206 and len(r.content) == 100
    assert client.get("/ai/media/videos/vid-learn/file").status_code == 401
    assert client.get("/ai/media/videos/vid-learn/file", headers=other).status_code == 404

    client.post(f"/ai/learn/items/{video}/position", headers=sv, json={"position": 42})
    assert client.get(f"/ai/learn/items/{video}", headers=sv).json()["progress_position"] == 42
    r1 = client.post(f"/ai/learn/items/{video}/complete", headers=sv).json()
    r2 = client.post(f"/ai/learn/items/{video}/complete", headers=sv).json()
    assert r1["xp_awarded"] > 0 and r2["xp_awarded"] == 0  # XP chỉ cộng một lần
    lesson = client.get(f"/ai/learn/lessons/{lid}", headers=sv).json()
    assert [i["status"] for i in lesson["items"]] == ["done", "current", "locked"]

    rd = client.get(f"/ai/learn/items/{reading}", headers=sv).json()
    assert "Tính đóng gói" in rd["reading"]["content_md"] and rd["reading"]["document_id"]
    client.post(f"/ai/learn/items/{reading}/complete", headers=sv)

    # quiz chưa có câu duyệt -> 409
    r = client.post(f"/ai/learn/items/{quiz}/quiz/start", headers=sv)
    assert r.status_code == 409 and r.json()["error"]["code"] == "QUIZ_EMPTY"
    gen = client.post("/ai/teacher/generate-quiz", headers=teacher,
                      json={"lesson_id": "lesson-learn", "count": 3, "question_types": ["multiple_choice"]}).json()
    for q in gen["questions"]:
        client.patch(f"/ai/question-bank/{q['item_id']}", headers=teacher, json={"status": "approved"})
    assert client.get(f"/ai/learn/items/{quiz}", headers=sv).json()["quiz"]["available"] == 3

    start = client.post(f"/ai/learn/items/{quiz}/quiz/start", headers=sv).json()
    assert len(start["questions"]) == 2 and "correct_index" not in start["questions"][0]
    for q in start["questions"]:
        a = client.post(f"/ai/learn/items/{quiz}/quiz/answer", headers=sv,
                        json={"question_id": q["question_id"], "selected_index": 1}).json()
        assert a["is_correct"] is True and a["correct_index"] == 1
    fin = client.post(f"/ai/learn/items/{quiz}/quiz/finish", headers=sv).json()
    assert fin["passed"] and fin["correct"] == 2 and fin["xp_awarded"] > 0
    # câu không thuộc lượt làm bài -> 409
    outside = next(q["item_id"] for q in gen["questions"] if q["item_id"] not in [x["question_id"] for x in start["questions"]])
    r = client.post(f"/ai/learn/items/{quiz}/quiz/answer", headers=sv, json={"question_id": outside, "selected_index": 0})
    assert r.status_code == 409

    me = client.get("/ai/learn/me", headers=sv).json()
    assert me["stats"]["total_xp"] >= r1["xp_awarded"] + fin["xp_awarded"]
    assert me["stats"]["streak_days"] == 1 and me["stats"]["studied_today"]
    assert client.put("/ai/learn/goal", headers=sv, json={"daily_goal_xp": 30}).status_code == 200
    assert client.put("/ai/learn/goal", headers=sv, json={"daily_goal_xp": 7}).status_code in (400, 422)
    board = client.get("/ai/learn/leaderboard", headers=sv).json()
    assert any(row["user_id"] == "sv-learn" for row in board["rows"])

    loc = client.get(f"/ai/learn/locate?video_id=vid-learn&lesson_id={lid}", headers=sv).json()
    assert loc["item_id"] == video


def test_course_admin_reorder_rename_delete(client, teacher):
    r = client.post("/ai/courses", headers=teacher, json={"code": "course-edit", "title": "Sửa", "class_id": "lop-a"})
    cid = r.json()["course_id"]
    assert client.post("/ai/courses", headers=teacher, json={"code": "course-edit", "title": "Trùng"}).status_code == 409
    client.post(f"/ai/courses/{cid}/chapters", headers=teacher, json={"title": "A"})
    tree = client.post(f"/ai/courses/{cid}/chapters", headers=teacher, json={"title": "B"}).json()
    b = tree["chapters"][1]["chapter_id"]
    tree = client.post(f"/ai/chapters/{b}/move", headers=teacher, json={"direction": -1}).json()
    assert [c["title"] for c in tree["chapters"]] == ["B", "A"]
    tree = client.patch(f"/ai/chapters/{b}", headers=teacher, json={"title": "B2"}).json()
    assert tree["chapters"][0]["title"] == "B2"
    tree = client.post(f"/ai/chapters/{b}/lessons", headers=teacher, json={"code": "lesson-edit", "title": "L"}).json()
    lid = tree["chapters"][0]["lessons"][0]["lesson_id"]
    tree = client.post(f"/ai/lessons/{lid}/items", headers=teacher, json={"type": "quiz", "title": "Q"}).json()
    item = tree["chapters"][0]["lessons"][0]["items"][0]["item_id"]
    tree = client.patch(f"/ai/items/{item}", headers=teacher, json={"title": "Q2", "count": 3}).json()
    it = tree["chapters"][0]["lessons"][0]["items"][0]
    assert it["title"] == "Q2" and it["meta"]["count"] == 3
    # loại mục sai / thiếu video -> lỗi rõ ràng
    assert client.post(f"/ai/lessons/{lid}/items", headers=teacher, json={"type": "audio", "title": "x"}).status_code == 400
    assert client.post(f"/ai/lessons/{lid}/items", headers=teacher, json={"type": "video", "title": "x"}).status_code == 400
    # giáo viên lớp khác không sửa được
    gv2 = token(client, "gv-2", "teacher", ["lop-b"])
    assert client.get(f"/ai/courses/{cid}", headers=gv2).status_code == 404
    # học sinh không vào được API soạn
    sv = token(client, "sv-x", "student", ["lop-a"])
    assert client.get("/ai/courses", headers=sv).status_code == 403
    tree = client.delete(f"/ai/items/{item}", headers=teacher).json()
    assert tree["chapters"][0]["lessons"][0]["items"] == []
    assert client.delete(f"/ai/courses/{cid}", headers=teacher).json()["deleted"] is True
