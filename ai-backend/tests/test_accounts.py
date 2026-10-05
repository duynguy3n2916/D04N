"""Tài khoản thật: đăng ký, đăng nhập, đổi mật khẩu, thu hồi phiên, quản lý học sinh/lớp."""
from app.core.passwords import hash_password, verify_password
from tests.conftest import token


def _auth(r):
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def test_password_hashing():
    h = hash_password("MatKhau123")
    assert h.startswith("scrypt$") and "MatKhau123" not in h
    assert verify_password("MatKhau123", h) and not verify_password("matkhau123", h)
    assert not verify_password("x", None) and not verify_password("x", "rác")


def test_register_login_lockout_change_password(client):
    assert client.get("/ai/auth/config").json()["allow_registration"] is True
    # mật khẩu yếu / tên không hợp lệ
    r = client.post("/ai/auth/register", json={"username": "hs.moi", "password": "abc"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "WEAK_PASSWORD"
    assert client.post("/ai/auth/register", json={"username": "Có Dấu", "password": "Matkhau123"}).status_code == 400

    r = client.post("/ai/auth/register", json={"username": "HS.Moi", "password": "Matkhau123", "display_name": "Học Sinh Mới",
                                               "email": "hs.moi@example.com"})
    h = _auth(r)
    me = r.json()["user"]
    assert me["user_id"] == "hs.moi" and me["role"] == "student" and me["class_ids"] == []
    assert client.post("/ai/auth/register", json={"username": "hs.moi", "password": "Matkhau123"}).status_code == 409
    assert client.post("/ai/auth/register", json={"username": "hs.khac", "password": "Matkhau123",
                                                  "email": "HS.MOI@example.com"}).status_code == 409
    # không thể tự đăng ký làm giáo viên: vai trò luôn là student
    assert client.get("/ai/courses", headers=h).status_code == 403

    # đăng nhập bằng tên hoặc email, sai mật khẩu báo chung chung
    assert client.post("/ai/auth/login", json={"username": "hs.moi", "password": "Matkhau123"}).status_code == 200
    assert client.post("/ai/auth/login", json={"username": "hs.moi@example.com", "password": "Matkhau123"}).status_code == 200
    bad = client.post("/ai/auth/login", json={"username": "hs.moi", "password": "sai"})
    ghost = client.post("/ai/auth/login", json={"username": "khong-ton-tai", "password": "sai"})
    assert bad.status_code == ghost.status_code == 401 and bad.json()["error"]["message"] == ghost.json()["error"]["message"]

    # đổi mật khẩu: sai mật khẩu cũ -> 400; đúng -> token cũ bị thu hồi, token mới dùng được
    assert client.post("/ai/auth/change-password", headers=h,
                       json={"current_password": "nham123a", "new_password": "MatKhauMoi9"}).status_code == 400
    r = client.post("/ai/auth/change-password", headers=h, json={"current_password": "Matkhau123", "new_password": "MatKhauMoi9"})
    h2 = _auth(r)
    old = client.get("/ai/auth/me", headers=h)
    assert old.status_code == 401 and old.json()["error"]["code"] == "SESSION_REVOKED"
    assert client.get("/ai/auth/me", headers=h2).json()["user_id"] == "hs.moi"
    assert client.post("/ai/auth/login", json={"username": "hs.moi", "password": "Matkhau123"}).status_code == 401

    # nhập sai nhiều lần không khóa tài khoản
    for _ in range(6):
        assert client.post("/ai/auth/login", json={"username": "hs.moi", "password": "sai-mat-khau1"}).status_code == 401
    assert client.post("/ai/auth/login", json={"username": "hs.moi", "password": "MatKhauMoi9"}).status_code == 200

    # đăng xuất mọi thiết bị
    assert client.post("/ai/auth/logout-all", headers=h2).status_code == 200
    assert client.get("/ai/auth/me", headers=h2).status_code == 401


def test_teacher_manages_class_and_students(client):
    admin = token(client, "admin-acc", "admin")
    gv = token(client, "gv-acc", "teacher", [])
    # giáo viên tạo lớp -> tự thành giáo viên lớp đó
    r = client.post("/ai/classes", headers=gv, json={"class_id": "LOP-ACC", "name": "Lớp thử"})
    assert r.status_code == 201, r.text
    code = r.json()["join_code"]
    assert client.get("/ai/auth/me", headers=gv).json()["class_ids"] == ["LOP-ACC"]
    assert client.post("/ai/classes", headers=gv, json={"class_id": "LOP-ACC"}).status_code == 409

    # tạo một học sinh: mật khẩu tạm, bắt đổi ở lần đầu
    r = client.post("/ai/users", headers=gv, json={"username": "hs-acc-1", "display_name": "An", "class_ids": ["LOP-ACC"]})
    assert r.status_code == 201, r.text
    temp = r.json()["temporary_password"]
    assert temp and r.json()["user"]["must_change_password"] is True
    # giáo viên không tạo được giáo viên / học sinh ngoài lớp mình
    assert client.post("/ai/users", headers=gv, json={"username": "gv-x", "role": "teacher", "class_ids": ["LOP-ACC"]}).status_code == 403
    assert client.post("/ai/users", headers=gv, json={"username": "hs-x", "class_ids": ["LOP-KHAC"]}).status_code == 403

    login = client.post("/ai/auth/login", json={"username": "hs-acc-1", "password": temp})
    hs = _auth(login)
    assert login.json()["user"]["must_change_password"] is True
    blocked = client.get("/ai/learn/courses", headers=hs)
    assert blocked.status_code == 403 and blocked.json()["error"]["code"] == "PASSWORD_CHANGE_REQUIRED"
    hs = _auth(client.post("/ai/auth/change-password", headers=hs, json={"current_password": temp, "new_password": "HocSinh2026"}))
    assert client.get("/ai/learn/courses", headers=hs).status_code == 200

    # nhập CSV (dấu ; và tiêu đề tiếng Việt), dòng lỗi không chặn dòng khác
    csv_text = "ten_dang_nhap;ho_ten;lop\nhs-acc-2;Bình;\nhs-acc-3;Chi;LOP-ACC\nhs-acc-1;Trùng;\nTên Sai;X;\n"
    r = client.post("/ai/users/import", headers=gv, json={"csv": csv_text, "default_class_id": "LOP-ACC"})
    body = r.json()
    assert [c["user_id"] for c in body["created"]] == ["hs-acc-2", "hs-acc-3"]
    assert all(c["password"] for c in body["created"]) and len(body["errors"]) == 2

    # học sinh tự đăng ký bằng mã lớp
    r = client.post("/ai/auth/register", json={"username": "hs-acc-4", "password": "Matkhau456", "class_code": code.lower()})
    assert r.json()["user"]["class_ids"] == ["LOP-ACC"]
    assert client.post("/ai/auth/register", json={"username": "hs-acc-5", "password": "Matkhau456",
                                                  "class_code": "SAIMA1"}).status_code == 404

    rows = client.get("/ai/users", headers=gv).json()
    assert {r["user_id"] for r in rows} == {"hs-acc-1", "hs-acc-2", "hs-acc-3", "hs-acc-4"}
    assert client.get("/ai/classes", headers=gv).json()[0]["students"] == 4

    # cấp lại mật khẩu -> phiên cũ bị thu hồi
    r = client.post("/ai/users/hs-acc-1/reset-password", headers=gv)
    assert r.json()["temporary_password"]
    assert client.get("/ai/auth/me", headers=hs).status_code == 401

    # khóa tài khoản: không đăng nhập được
    client.patch("/ai/users/hs-acc-4", headers=gv, json={"is_active": False})
    r = client.post("/ai/auth/login", json={"username": "hs-acc-4", "password": "Matkhau456"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "ACCOUNT_DISABLED"

    # giáo viên lớp khác không thấy / không sửa được
    gv2 = token(client, "gv-acc-2", "teacher", ["LOP-B"])
    assert client.get("/ai/users", headers=gv2).json() == []
    assert client.patch("/ai/users/hs-acc-2", headers=gv2, json={"display_name": "x"}).status_code == 404
    # chỉ admin đổi vai trò; vai trò mới có hiệu lực ngay với token đang dùng
    assert client.patch("/ai/users/hs-acc-2", headers=gv, json={"role": "teacher"}).status_code == 403
    temp2 = body["created"][0]["password"]
    hs2 = _auth(client.post("/ai/auth/login", json={"username": "hs-acc-2", "password": temp2}))
    hs2 = _auth(client.post("/ai/auth/change-password", headers=hs2, json={"current_password": temp2, "new_password": "BinhBinh22"}))
    assert client.get("/ai/courses", headers=hs2).status_code == 403
    assert client.patch("/ai/users/hs-acc-2", headers=admin, json={"role": "teacher"}).json()["role"] == "teacher"
    assert client.get("/ai/courses", headers=hs2).status_code == 200
    # admin không tự khóa mình
    assert client.patch("/ai/users/admin-acc", headers=admin, json={"is_active": False}).status_code == 400


def test_unknown_user_token_rejected(client):
    from app.core.security import create_token
    t = create_token("nguoi-la", "admin", [])
    r = client.get("/ai/auth/me", headers={"Authorization": f"Bearer {t}"})
    assert r.status_code == 401 and r.json()["error"]["code"] == "UNKNOWN_USER"
