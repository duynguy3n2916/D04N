"""Hạ tầng test: Postgres thật (pgvector), embedding 'hash', LLM giả lập."""
import os

import pytest

os.environ.setdefault("TEST_DATABASE_URL", "postgresql://postgres:postgres@localhost:5433/ai_pytest")
os.environ["DATABASE_URL"] = os.environ["TEST_DATABASE_URL"]
os.environ["EMBEDDING_PROVIDER"] = "hash"
os.environ["EMBEDDING_DIM"] = "384"
os.environ["LLM_PROVIDER"] = "claude"
os.environ["CLAUDE_API_KEY"] = "test-key"
os.environ["RAG_MIN_SCORE"] = "0.15"
os.environ["JWT_SECRET"] = "test-secret-key-for-pytest-only-0123456789"
os.environ["ALLOW_TEST_LOGIN"] = "true"
os.environ["ALLOW_REGISTRATION"] = "true"
os.environ["STORAGE_PATH"] = os.environ.get("TEST_STORAGE_PATH", "/tmp/ai_test_storage")


def _create_database():
    from sqlalchemy import create_engine, text
    from sqlalchemy.engine import make_url
    url = make_url(os.environ["DATABASE_URL"])
    admin = create_engine(url.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f'DROP DATABASE IF EXISTS "{url.database}" WITH (FORCE)'))
        c.execute(text(f'CREATE DATABASE "{url.database}"'))
    admin.dispose()


_create_database()

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.services import jobs, llm  # noqa: E402
from tests.fake_llm import FakeLLM  # noqa: E402

jobs.set_inline(True)


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def fake_llm(monkeypatch):
    fake = FakeLLM()
    monkeypatch.setattr(llm, "_call_provider", fake)
    return fake


def token(client, user_id, role, class_ids=None):
    r = client.post("/ai/auth/demo-login", json={"user_id": user_id, "role": role, "class_ids": class_ids or []})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture(scope="session")
def teacher(client):
    return token(client, "gv-1", "teacher", ["lop-a"])


@pytest.fixture(scope="session")
def admin(client):
    return token(client, "admin-1", "admin")


LESSON_TEXT = (
    "# Tính đóng gói\n\nĐóng gói là gom dữ liệu và phương thức vào trong một lớp, che giấu chi tiết bên trong. "
    "Getter và setter đọc và cập nhật thuộc tính private có kiểm soát.\n\n"
    "# Tính kế thừa\n\nKế thừa cho phép lớp con tái sử dụng thuộc tính và phương thức của lớp cha. "
    "Hàm super gọi phương thức của lớp cha.\n\n"
    "# Tính đa hình\n\nĐa hình là cùng một lời gọi phương thức nhưng hành vi khác nhau tùy đối tượng. "
    "Ghi đè và nạp chồng là hai dạng đa hình.\n"
)

SRT = "\n".join(
    f"{i + 1}\n00:{(i * 10) // 60:02d}:{(i * 10) % 60:02d},000 --> 00:{(i * 10 + 9) // 60:02d}:{(i * 10 + 9) % 60:02d},000\n{t}\n"
    for i, t in enumerate([
        "Hôm nay học về lập trình hướng đối tượng.",
        "Đóng gói là gom dữ liệu và phương thức vào lớp.",
        "Đóng gói che giấu dữ liệu bên trong lớp.",
        "Getter và setter đọc và ghi thuộc tính private.",
        "Kế thừa cho phép lớp con dùng lại lớp cha.",
        "Ví dụ lớp chó kế thừa lớp động vật.",
        "Hàm super gọi hàm khởi tạo của lớp cha.",
        "Đa hình là cùng lời gọi nhưng hành vi khác nhau.",
        "Ghi đè phương thức là định nghĩa lại ở lớp con.",
        "Nạp chồng là cùng tên khác tham số.",
        "Trừu tượng là ẩn chi tiết cài đặt.",
        "Lớp trừu tượng không tạo được đối tượng.",
        "Tổng kết bốn tính chất của OOP.",
    ])
)
