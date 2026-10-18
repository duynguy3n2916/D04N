"""AI theo bài: thẻ ghi nhớ soạn từ học liệu (duyệt trước khi ôn) và sơ đồ tư duy có nguồn để nhảy về bài giảng."""
from tests.conftest import LESSON_TEXT, token
from tests.test_api_core import upload


def _lesson(client, teacher, code):
    cid = client.post("/ai/courses", headers=teacher, json={"code": f"course-{code}", "title": "AI theo bài", "class_id": "lop-a"}).json()["course_id"]
    tree = client.post(f"/ai/courses/{cid}/chapters", headers=teacher, json={"title": "C1"}).json()
    ch = tree["chapters"][0]["chapter_id"]
    client.post(f"/ai/chapters/{ch}/lessons", headers=teacher, json={"code": code, "title": "Bài OOP"})
    upload(client, teacher, f"{code}.md", LESSON_TEXT, lesson_id=code, class_id="lop-a")


def test_ai_flashcards_need_approval(client, teacher, fake_llm):
    _lesson(client, teacher, "lesson-fcai")
    sv = token(client, "sv-fcai", "student", ["lop-a"])
    assert client.post("/ai/lessons/lesson-fcai/flashcards/generate", headers=sv, json={"count": 2}).status_code == 403

    cards = client.post("/ai/lessons/lesson-fcai/flashcards/generate", headers=teacher, json={"count": 2}).json()
    assert len(cards) == 2 and all(c["status"] == "draft" for c in cards)
    assert cards[0]["sources"] and cards[0]["sources"][0]["label"] == "S1"  # nhãn đã được giải thành nguồn đầy đủ

    # chưa duyệt: học sinh chưa có thẻ để ôn
    assert client.get("/ai/learn/flashcards/lesson-fcai/summary", headers=sv).json()["total"] == 0
    r = client.patch(f"/ai/flashcard-cards/{cards[0]['card_id']}", headers=teacher,
                     json={"front": "Tính đóng gói là gì?", "status": "approved"}).json()
    assert r["status"] == "approved" and r["front"] == "Tính đóng gói là gì?"
    client.patch(f"/ai/flashcard-cards/{cards[1]['card_id']}", headers=teacher, json={"status": "rejected"})

    due = client.get("/ai/learn/flashcards/lesson-fcai/due", headers=sv).json()
    assert [c["front"] for c in due["cards"]] == ["Tính đóng gói là gì?"] and due["cards"][0]["type"] == "flashcard"
    rv = client.post(f"/ai/learn/flashcards/{cards[0]['card_id']}/review", headers=sv, json={"rating": "good"})
    assert rv.status_code == 200 and rv.json()["reps"] == 1
    # thẻ bị từ chối không ôn được
    assert client.post(f"/ai/learn/flashcards/{cards[1]['card_id']}/review", headers=sv, json={"rating": "good"}).status_code == 404


def test_mindmap_generate_approve_and_sources(client, teacher, fake_llm):
    _lesson(client, teacher, "lesson-mm")
    sv = token(client, "sv-mm", "student", ["lop-a"])
    assert client.post("/ai/lessons/lesson-mm/mindmap/generate", headers=sv).status_code == 403

    m = client.post("/ai/lessons/lesson-mm/mindmap/generate", headers=teacher).json()
    assert m["status"] == "draft" and m["version"] == 1
    root = m["tree"]
    assert root["title"] == "Lập trình hướng đối tượng" and len(root["children"]) == 2
    dong_goi, ke_thua = root["children"]
    assert dong_goi["sources"][0]["label"] == "S1" and dong_goi["sources"][0]["document_id"]
    assert dong_goi["children"][0]["title"] == "Getter / setter"
    assert [s["label"] for s in ke_thua["sources"]] == ["S2"]  # nhãn S99 không tồn tại bị bỏ

    # nháp: học sinh chưa thấy; giáo viên thấy bản mới nhất
    assert client.get("/ai/learn/lessons/lesson-mm/mindmap", headers=sv).json()["approved"] is None
    assert client.get("/ai/learn/lessons/lesson-mm/mindmap", headers=teacher).json()["latest"]["mindmap_id"] == m["mindmap_id"]

    # giáo viên sửa tên nút rồi duyệt
    root["children"][0]["title"] = "Tính đóng gói"
    r = client.patch(f"/ai/mindmaps/{m['mindmap_id']}", headers=teacher, json={"tree": root, "status": "approved"})
    assert r.status_code == 200 and r.json()["status"] == "approved"
    got = client.get("/ai/learn/lessons/lesson-mm/mindmap", headers=sv).json()["approved"]
    assert got["tree"]["children"][0]["title"] == "Tính đóng gói" and "latest" not in client.get(
        "/ai/learn/lessons/lesson-mm/mindmap", headers=sv).json()

    # bản mới được duyệt thì bản cũ chuyển sang lưu trữ
    m2 = client.post("/ai/lessons/lesson-mm/mindmap/generate", headers=teacher).json()
    assert m2["version"] == 2
    client.patch(f"/ai/mindmaps/{m2['mindmap_id']}", headers=teacher, json={"status": "approved"})
    assert client.get("/ai/learn/lessons/lesson-mm/mindmap", headers=sv).json()["approved"]["version"] == 2

    # cây không hợp lệ bị từ chối; học sinh lớp khác không xem được
    bad = client.patch(f"/ai/mindmaps/{m2['mindmap_id']}", headers=teacher, json={"tree": {"title": "", "children": []}})
    assert bad.status_code == 400
    other = token(client, "sv-mm-khac", "student", ["lop-z"])
    assert client.get("/ai/learn/lessons/lesson-mm/mindmap", headers=other).status_code == 404


def test_mindmap_requires_material(client, teacher, fake_llm):
    cid = client.post("/ai/courses", headers=teacher, json={"code": "course-mm-empty", "title": "Rỗng", "class_id": "lop-a"}).json()["course_id"]
    tree = client.post(f"/ai/courses/{cid}/chapters", headers=teacher, json={"title": "C1"}).json()
    client.post(f"/ai/chapters/{tree['chapters'][0]['chapter_id']}/lessons", headers=teacher, json={"code": "lesson-mm-empty", "title": "Rỗng"})
    r = client.post("/ai/lessons/lesson-mm-empty/mindmap/generate", headers=teacher)
    assert r.status_code == 400 and r.json()["error"]["code"] == "NO_CONTEXT"
