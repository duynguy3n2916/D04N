"""Mạng xã hội học tập: bảng tin (loại bài, thẻ, tìm kiếm, sắp xếp), thích, bình luận lồng, @nhắc tên,
ảnh đính kèm, hộp thông báo, nhắn tin riêng (chặn, báo cáo, giáo viên chỉ thấy tin bị báo cáo)."""
import io

from tests.conftest import token

PNG = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
       b"\x00\x00\x00\rIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82")


def _post(client, h, cls, **kw):
    body = {"title": kw.pop("title", "Tiêu đề"), "body": kw.pop("body", "Nội dung"), **kw}
    r = client.post(f"/ai/forum/classes/{cls}/threads", headers=h, json=body)
    assert r.status_code == 201, r.text
    return r.json()["thread_id"]


def test_feed_kinds_tags_search_sort_and_likes(client):
    a = token(client, "sn-a", "student", ["lop-sn"])
    b = token(client, "sn-b", "student", ["lop-sn"])
    gv = token(client, "sn-gv", "teacher", ["lop-sn"])

    # chỉ giáo viên đăng thông báo
    assert client.post("/ai/forum/classes/lop-sn/threads", headers=a,
                       json={"title": "x", "body": "y", "kind": "announcement"}).status_code == 403
    ann = _post(client, gv, "lop-sn", title="Lịch kiểm tra", kind="announcement")
    q1 = _post(client, a, "lop-sn", title="Hỏi về đóng gói", body="getter là gì", tags=["#OOP", "dong-goi", "OOP"])
    p1 = _post(client, b, "lop-sn", title="Chia sẻ tài liệu kế thừa", kind="post", tags=["oop"])

    feed = client.get("/ai/forum/classes/lop-sn/threads", headers=a).json()
    assert feed[0]["thread_id"] == ann and feed[0]["kind"] == "announcement"  # thông báo luôn ở đầu
    q = next(t for t in feed if t["thread_id"] == q1)
    assert q["tags"] == ["oop", "dong-goi"]  # chuẩn hóa chữ thường, bỏ #, bỏ trùng

    assert {t["thread_id"] for t in client.get("/ai/forum/classes/lop-sn/threads?tag=oop", headers=a).json()} == {q1, p1}
    assert [t["thread_id"] for t in client.get("/ai/forum/classes/lop-sn/threads?q=getter", headers=a).json()] == [q1]
    assert [t["thread_id"] for t in client.get("/ai/forum/classes/lop-sn/threads?kind=post", headers=a).json()] == [p1]
    assert q1 in [t["thread_id"] for t in client.get("/ai/forum/classes/lop-sn/threads?sort=unanswered", headers=a).json()]

    # thích / bỏ thích; "nổi bật" xếp theo lượt thích
    r = client.post("/ai/forum/likes", headers=a, json={"target_type": "thread", "target_id": p1}).json()
    assert r == {"liked": True, "like_count": 1}
    client.post("/ai/forum/likes", headers=gv, json={"target_type": "thread", "target_id": p1})
    top = [t for t in client.get("/ai/forum/classes/lop-sn/threads?sort=top", headers=b).json() if t["kind"] != "announcement"]
    assert top[0]["thread_id"] == p1 and top[0]["like_count"] == 2
    assert client.post("/ai/forum/likes", headers=a, json={"target_type": "thread", "target_id": p1}).json()["liked"] is False
    other = token(client, "sn-x", "student", ["lop-khac"])
    assert client.post("/ai/forum/likes", headers=other, json={"target_type": "thread", "target_id": p1}).status_code == 403


def test_nested_replies_mentions_and_inbox(client):
    a = token(client, "sn-c", "student", ["lop-sn2"])
    b = token(client, "sn-d", "student", ["lop-sn2"])
    c = token(client, "sn-e", "student", ["lop-sn2"])
    token(client, "sn-ngoai", "student", ["lop-khac2"])
    tid = _post(client, a, "lop-sn2", title="Hỏi kế thừa", body="nhờ @sn-e xem giúp, cả @sn-ngoai nữa")

    # chỉ người cùng lớp được nhắc mới nhận thông báo
    inbox_e = client.get("/ai/notifications/inbox", headers=c).json()
    assert inbox_e and inbox_e[0]["kind"] == "mention" and inbox_e[0]["thread_id"] == tid
    assert client.get("/ai/notifications/inbox", headers=token(client, "sn-ngoai", "student", ["lop-khac2"])).json() == []

    r1 = client.post(f"/ai/forum/threads/{tid}/replies", headers=b, json={"body": "Lớp con dùng lại lớp cha"}).json()
    r2 = client.post(f"/ai/forum/threads/{tid}/replies", headers=c, json={"body": "đồng ý", "parent_id": r1["reply_id"]}).json()
    assert r2["parent_id"] == r1["reply_id"]
    # trả lời một bình luận con thì vẫn gắn vào bình luận gốc (chỉ lồng 1 tầng)
    r3 = client.post(f"/ai/forum/threads/{tid}/replies", headers=a, json={"body": "cảm ơn", "parent_id": r2["reply_id"]}).json()
    assert r3["parent_id"] == r1["reply_id"]

    kinds_a = [n["kind"] for n in client.get("/ai/notifications/inbox", headers=a).json()]
    assert kinds_a.count("reply") == 2  # sn-d và sn-e trả lời bài của sn-c
    inbox_b = client.get("/ai/notifications/inbox", headers=b).json()
    assert any(n["kind"] == "reply" and "bình luận" in n["text"] for n in inbox_b)

    s = client.get("/ai/notifications/summary", headers=a).json()
    assert s["inbox_unread"] == 2
    client.post("/ai/notifications/inbox/read", headers=a, json={})
    assert client.get("/ai/notifications/summary", headers=a).json()["inbox_unread"] == 0

    # thích bình luận; xóa bình luận gốc thì bình luận con cũng mất
    client.post("/ai/forum/likes", headers=a, json={"target_type": "reply", "target_id": r1["reply_id"]})
    d = client.get(f"/ai/forum/threads/{tid}", headers=a).json()
    assert next(r for r in d["replies"] if r["reply_id"] == r1["reply_id"])["like_count"] == 1
    assert client.delete(f"/ai/forum/replies/{r1['reply_id']}", headers=b).status_code == 204
    assert client.get(f"/ai/forum/threads/{tid}", headers=a).json()["replies"] == []


def test_images_attach_and_access(client):
    a = token(client, "sn-f", "student", ["lop-sn3"])
    b = token(client, "sn-g", "student", ["lop-sn3"])
    out = token(client, "sn-h", "student", ["lop-khac3"])
    up = client.post("/ai/forum/classes/lop-sn3/images", headers=a, files={"file": ("a.png", io.BytesIO(PNG), "image/png")})
    assert up.status_code == 201, up.text
    img = up.json()["image_id"]
    bad = client.post("/ai/forum/classes/lop-sn3/images", headers=a, files={"file": ("a.exe", io.BytesIO(b"MZ"), "x")})
    assert bad.status_code == 400

    # người khác không gắn được ảnh của mình vào bài của họ
    assert client.post("/ai/forum/classes/lop-sn3/threads", headers=b,
                       json={"title": "t", "body": "b", "images": [img]}).status_code == 400
    tid = _post(client, a, "lop-sn3", title="Có ảnh", images=[img])
    t = client.get(f"/ai/forum/threads/{tid}", headers=b).json()
    assert t["images"] == [f"/ai/forum/images/{img}"]
    r = client.get(t["images"][0], headers=b)
    assert r.status_code == 200 and r.content == PNG and r.headers["content-type"].startswith("image/png")
    assert client.get(t["images"][0], headers=out).status_code == 404  # ngoài lớp không xem được


def test_direct_messages_block_report(client, teacher):
    a = token(client, "dm-a", "student", ["lop-dm"])
    b = token(client, "dm-b", "student", ["lop-dm"])
    gv = token(client, "dm-gv", "teacher", ["lop-dm"])
    stranger = token(client, "dm-x", "student", ["lop-khac-dm"])

    assert client.post("/ai/messages/conversations", headers=a, json={"user_id": "dm-x"}).status_code == 403
    assert client.post("/ai/messages/conversations", headers=a, json={"user_id": "dm-a"}).status_code == 400
    conv = client.post("/ai/messages/conversations", headers=a, json={"user_id": "dm-b"}).json()
    # mở lại không tạo hội thoại mới, từ phía người kia cũng là cùng hội thoại
    assert client.post("/ai/messages/conversations", headers=b, json={"user_id": "dm-a"}).json()["conversation_id"] == conv["conversation_id"]
    cid = conv["conversation_id"]

    m1 = client.post(f"/ai/messages/conversations/{cid}", headers=a, json={"body": "Chào bạn"}).json()
    client.post(f"/ai/messages/conversations/{cid}", headers=a, json={"body": "Bài 2 làm sao?"})
    assert client.get("/ai/notifications/summary", headers=b).json()["dm_unread"] == 2
    lst = client.get("/ai/messages/conversations", headers=b).json()
    assert lst[0]["unread"] == 2 and lst[0]["last_message"] == "Bài 2 làm sao?"
    msgs = client.get(f"/ai/messages/conversations/{cid}", headers=b).json()["messages"]
    assert [m["body"] for m in msgs] == ["Chào bạn", "Bài 2 làm sao?"] and not msgs[0]["mine"]
    assert client.get("/ai/notifications/summary", headers=b).json()["dm_unread"] == 0  # đã đọc
    # người ngoài hội thoại không đọc được
    assert client.get(f"/ai/messages/conversations/{cid}", headers=stranger).status_code == 404
    assert client.get(f"/ai/messages/conversations/{cid}", headers=gv).status_code == 404

    # báo cáo: giáo viên thấy đúng tin bị báo cáo, ẩn được
    assert client.post(f"/ai/messages/{m1['message_id']}/report", headers=a, json={"reason": "x"}).status_code == 400
    client.post(f"/ai/messages/{m1['message_id']}/report", headers=b, json={"reason": "Làm phiền"})
    assert client.get("/ai/messages/reports/lop-dm", headers=b).status_code == 403
    reps = client.get("/ai/messages/reports/lop-dm", headers=gv).json()
    assert len(reps) == 1 and reps[0]["body"] == "Chào bạn"
    client.post(f"/ai/messages/reports/{reps[0]['report_id']}/resolve", headers=gv, json={"action": "hide"})
    first = client.get(f"/ai/messages/conversations/{cid}", headers=b).json()["messages"][0]
    assert first["hidden"] and first["body"] == "(Tin nhắn đã bị ẩn)"

    # chặn: không ai nhắn được cho ai; bỏ chặn thì nhắn lại được
    client.post("/ai/messages/blocks", headers=b, json={"user_id": "dm-a", "blocked": True})
    assert client.post(f"/ai/messages/conversations/{cid}", headers=a, json={"body": "?"}).status_code == 403
    assert client.post(f"/ai/messages/conversations/{cid}", headers=b, json={"body": "?"}).status_code == 403
    client.post("/ai/messages/blocks", headers=b, json={"user_id": "dm-a", "blocked": False})
    assert client.post(f"/ai/messages/conversations/{cid}", headers=a, json={"body": "ok"}).status_code == 201


def test_lesson_tags_on_posts(client):
    gv = token(client, "sn-gv4", "teacher", ["lop-sn4"])
    a = token(client, "sn-i", "student", ["lop-sn4"])
    out = token(client, "sn-j", "student", ["lop-khac4"])
    course = client.post("/ai/courses", headers=gv, json={"title": "Khóa OOP", "class_id": "lop-sn4"}).json()
    tree = client.post(f"/ai/courses/{course['course_id']}/chapters", headers=gv, json={"title": "Chương 1"}).json()
    lesson = client.post(f"/ai/chapters/{tree['chapters'][0]['chapter_id']}/lessons", headers=gv,
                         json={"title": "Đóng gói"}).json()["chapters"][0]["lessons"][0]

    lessons = client.get("/ai/forum/classes/lop-sn4/lessons", headers=a).json()
    assert {"code": lesson["code"], "title": "Đóng gói", "course_title": "Khóa OOP"} in lessons
    assert lesson["code"] not in [x["code"] for x in client.get("/ai/forum/classes/lop-khac4/lessons", headers=out).json()]
    assert client.get("/ai/forum/classes/lop-sn4/lessons", headers=out).status_code == 403

    tid = _post(client, a, "lop-sn4", title="Hỏi về bài đóng gói", lesson_code=lesson["code"])
    _post(client, a, "lop-sn4", title="Bài khác")
    feed = client.get(f"/ai/forum/classes/lop-sn4/threads?lesson_code={lesson['code']}", headers=a).json()
    assert [t["thread_id"] for t in feed] == [tid] and feed[0]["lesson_code"] == lesson["code"]
