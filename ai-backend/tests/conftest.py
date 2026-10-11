"""Hạ tầng test: Postgres thật (pgvector), embedding 'hash', LLM giả lập."""
import os

import pytest

from sqlalchemy.engine import make_url  # noqa: E402


def _env_file_value(key: str) -> str | None:
    """Đọc một khóa từ .env (không in giá trị) để so với TEST_DATABASE_URL."""
    try:
        with open(".env", encoding="utf-8") as f:
            for line in f:
                if line.startswith(f"{key}="):
                    return line.split("=", 1)[1].strip()
    except FileNotFoundError:
        pass
    return None


def _test_database_url() -> str:
    """Test chỉ chạy trên một database Postgres riêng (tên có 'test'), không bao giờ trên DB production."""
    url = os.environ.get("TEST_DATABASE_URL") or _env_file_value("TEST_DATABASE_URL")
    if not url:
        raise RuntimeError("Thiếu TEST_DATABASE_URL trong .env: trỏ tới một database Postgres riêng cho test (ví dụ branch Neon 'test').")
    prod = _env_file_value("DATABASE_URL")
    if prod:
        t, p = make_url(url), make_url(prod)
        same = (t.host or "").replace("-pooler", "") == (p.host or "").replace("-pooler", "") and t.database == p.database
        if same:
            raise RuntimeError("TEST_DATABASE_URL trỏ tới cùng database với DATABASE_URL (production). Dừng test để không xóa dữ liệu thật.")
    if "test" not in (make_url(url).database or "").lower():
        raise RuntimeError("Tên database test phải chứa chữ 'test' để tránh nhầm với database thật.")
    return url


os.environ["TEST_DATABASE_URL"] = _test_database_url()
os.environ["DATABASE_URL"] = os.environ["TEST_DATABASE_URL"]
os.environ["EMBEDDING_PROVIDER"] = "hash"
os.environ["EMBEDDING_DIM"] = "384"
os.environ["OPENAI_API_KEY"] = "test-key"
os.environ["RAG_MIN_SCORE"] = "0.15"
os.environ["JWT_SECRET"] = "test-secret-key-for-pytest-only-0123456789"
os.environ["ALLOW_TEST_LOGIN"] = "true"
os.environ["ALLOW_REGISTRATION"] = "true"
os.environ["STORAGE_PATH"] = os.environ.get("TEST_STORAGE_PATH", "/tmp/ai_test_storage")
os.environ["MEDIA_STORAGE"] = "local"  # test không được ghi lên R2 thật, dù .env đặt r2


def _reset_schema() -> None:
    """Xóa schema public của chính DB test rồi cho app tạo lại bảng (không tạo/xóa database)."""
    from sqlalchemy import create_engine, text
    engine = create_engine(os.environ["DATABASE_URL"], isolation_level="AUTOCOMMIT")
    with engine.connect() as c:
        c.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
        c.execute(text("CREATE SCHEMA public"))
        c.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    engine.dispose()
    from app.migrate import migrate
    migrate(verbose=False)


_reset_schema()

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
