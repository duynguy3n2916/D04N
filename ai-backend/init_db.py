"""Khởi tạo / nâng cấp database.

    python init_db.py            # tạo bảng mới + nâng cấp schema cũ (an toàn, chạy lại nhiều lần được)
    python init_db.py --seed     # + nạp dữ liệu demo (bài OOP, transcript video-01, câu hỏi mẫu, bộ đánh giá)
    python init_db.py --reset    # XÓA toàn bộ dữ liệu AI rồi tạo lại (hỏi xác nhận)
    python init_db.py --reembed  # đổi kích thước vector theo EMBEDDING_DIM và tạo lại embedding
    python init_db.py --create-admin admin   # tạo (hoặc đặt lại mật khẩu) tài khoản quản trị, nhập mật khẩu ẩn
"""
import argparse
import logging
import sys
from pathlib import Path

from sqlalchemy import text

import app.models  # noqa: F401
from app.config import settings
from app.core.context import setup_logging
from app.database import Base, SessionLocal, engine
from app.migrate import change_embedding_dim, embedding_dim_in_db, migrate

SAMPLE = Path(__file__).resolve().parent / "sample_data"
LESSON_ID, COURSE_ID, VIDEO_ID = "lesson-oop-01", "course-cs-101", "video-01"


def reset() -> None:
    ans = input("Xóa TOÀN BỘ dữ liệu AI (tài liệu, transcript, hội thoại, câu hỏi...)? Gõ 'yes' để tiếp tục: ")
    if ans.strip().lower() != "yes":
        print("Đã hủy.")
        sys.exit(1)
    Base.metadata.drop_all(bind=engine)
    print("Đã xóa bảng.")


def seed() -> None:
    from app.core.security import Principal
    from app.models.documents import AIDocument
    from app.models.video_question import VideoQuestion
    from app.services import jobs
    from app.services.evaluation import load_default_samples
    from app.services.ingestion import create_document, find_duplicate
    from app.services.storage import sha256_text
    from app.services.transcription import parse_srt, save_transcript_version
    from app.services.video_learning import save_question

    jobs.set_inline(True)
    db = SessionLocal()
    teacher = Principal(user_id="gv-demo", role="teacher", class_ids=[])
    try:
        content = (SAMPLE / "lesson_oop.md").read_text(encoding="utf-8")
        digest = sha256_text(content)
        if find_duplicate(db, digest, LESSON_ID, None):
            print("• Bài học demo đã có, bỏ qua.")
        else:
            doc = create_document(db, title="Bài 1: Lập trình hướng đối tượng", source_type="lesson", file_path=None,
                                  content_hash=digest, course_id=COURSE_ID, lesson_id=LESSON_ID, uploaded_by="gv-demo")
            job = jobs.submit(db, "ingest_document", {"document_id": str(doc.id), "text": content}, created_by="gv-demo")
            db.refresh(job)
            print(f"• Bài học demo: {job.status} {job.result or job.error}")

        has_video = db.query(AIDocument).filter(AIDocument.source_type == "video", AIDocument.source_id == VIDEO_ID).first()
        if has_video:
            print("• Transcript video-01 đã có, bỏ qua.")
        else:
            segs = parse_srt((SAMPLE / "video-01.srt").read_text(encoding="utf-8"))
            tr, kb = save_transcript_version(db, VIDEO_ID, segs, source="import", model_version="imported_subtitle",
                                             created_by="gv-demo", lesson_id=LESSON_ID, course_id=COURSE_ID)
            print(f"• Transcript video-01: {len(segs)} đoạn, KB {kb['status']}")

        if not db.query(VideoQuestion).filter(VideoQuestion.video_id == VIDEO_ID, VideoQuestion.origin == "teacher").first():
            save_question(db, teacher, VIDEO_ID, {
                "timestamp": 95, "type": "multiple_choice", "difficulty": "easy",
                "question": "Quan hệ giữa lớp và đối tượng được mô tả đúng nhất là gì?",
                "options": ["A. Lớp là thể hiện cụ thể của đối tượng", "B. Lớp là bản thiết kế, đối tượng là thể hiện cụ thể của lớp",
                            "C. Lớp và đối tượng là hai tên gọi của cùng một khái niệm", "D. Mỗi lớp chỉ tạo được một đối tượng"],
                "correct_answer": "B",
                "explanation": "Lớp giống bản vẽ ngôi nhà; đối tượng là ngôi nhà thật được xây từ bản vẽ, một lớp tạo được nhiều đối tượng.",
            })
            print("• Câu hỏi mẫu tại 01:35 của video-01: đã tạo")

        n = load_default_samples(db, "default", replace=True)
        print(f"• Bộ đánh giá 'default': {n} mẫu")
        seed_course(db, teacher)
    finally:
        db.close()


BANK_QUESTIONS = [
    ("Từ một lớp có thể tạo ra bao nhiêu đối tượng?", ["A. Chỉ một", "B. Tối đa hai", "C. Nhiều đối tượng", "D. Không tạo được"], "C",
     "Lớp là bản thiết kế; từ một lớp tạo được nhiều đối tượng với giá trị thuộc tính riêng.", "easy"),
    ("Mục đích chính của tính đóng gói là gì?", ["A. Tăng tốc chương trình", "B. Bảo vệ dữ liệu, che giấu chi tiết bên trong",
     "C. Cho phép đa kế thừa", "D. Tạo nhiều đối tượng"], "B", "Đóng gói gom dữ liệu và phương thức vào lớp, chỉ cho truy cập có kiểm soát.", "easy"),
    ("Hàm super() trong Python dùng để làm gì?", ["A. Gọi phương thức của lớp cha", "B. Tạo lớp trừu tượng",
     "C. Xóa đối tượng", "D. Khai báo thuộc tính private"], "A", "super() gọi phương thức lớp cha, thường là super().__init__().", "medium"),
    ("Ghi đè phương thức (overriding) là gì?", ["A. Nhiều phương thức cùng tên khác tham số trong một lớp",
     "B. Lớp con định nghĩa lại phương thức của lớp cha", "C. Ẩn thuộc tính bằng __", "D. Tạo đối tượng từ lớp trừu tượng"], "B",
     "Ghi đè: lớp con viết lại phương thức cùng tên cùng tham số của lớp cha — đa hình lúc chạy.", "medium"),
    ("Có thể tạo đối tượng trực tiếp từ lớp trừu tượng không?", ["A. Có, luôn được", "B. Có, nếu không có phương thức",
     "C. Không, lớp con phải cài đặt phương thức trừu tượng", "D. Chỉ trong Java"], "C",
     "Lớp trừu tượng không tạo đối tượng trực tiếp; lớp con phải cài đặt các phương thức trừu tượng.", "medium"),
    ("Quan hệ kế thừa thể hiện mối quan hệ nào?", ["A. has-a (có một)", "B. is-a (là một)", "C. uses-a (dùng một)",
     "D. part-of (thành phần)"], "B", "Kế thừa là quan hệ 'là một': Chó là một Động vật.", "easy"),
]


def seed_course(db, teacher) -> None:
    """Khóa học demo: chương 1 / bài 1 gồm video, slide, bài đọc, bài kiểm tra."""
    import shutil

    from app.core.llm_schemas import QuestionItem
    from app.models.documents import AIDocument
    from app.models.learning import Course, MediaVideo
    from app.models.video_question import QuestionBankItem
    from app.services import course_admin, jobs
    from app.services.ingestion import create_document, find_duplicate
    from app.services.storage import storage_dir

    if db.query(Course).filter(Course.code == COURSE_ID).first():
        print("• Khóa học demo đã có, bỏ qua.")
        return

    # File video demo (slide có phụ đề) để phát được ngay
    if not db.get(MediaVideo, VIDEO_ID):
        dst = storage_dir("media") / "video-01-demo.mp4"
        shutil.copyfile(SAMPLE / "video-01.mp4", dst)
        db.add(MediaVideo(video_id=VIDEO_ID, title="Lớp, đối tượng và 4 tính chất", file_path=str(dst),
                          mime="video/mp4", size_bytes=dst.stat().st_size, duration_seconds=307,
                          created_by="gv-demo"))
        db.commit()

    # Slide PDF -> Knowledge Base
    import hashlib
    pdf_src = SAMPLE / "slides_oop.pdf"
    digest = hashlib.sha256(pdf_src.read_bytes()).hexdigest()
    slide_doc = find_duplicate(db, digest, LESSON_ID, None)
    if not slide_doc:
        dst = storage_dir("documents") / "slides_oop_demo.pdf"
        shutil.copyfile(pdf_src, dst)
        slide_doc = create_document(db, title="Slide Bài 1 - 4 tính chất OOP.pdf", source_type="pdf",
                                    file_path=str(dst), content_hash=digest, course_id=COURSE_ID,
                                    lesson_id=LESSON_ID, uploaded_by="gv-demo")
        jobs.submit(db, "ingest_document", {"document_id": str(slide_doc.id)}, created_by="gv-demo")

    reading_doc = db.query(AIDocument).filter(AIDocument.lesson_id == LESSON_ID, AIDocument.source_type == "lesson").first()

    for q, opts, ans, exp, diff in BANK_QUESTIONS:
        item = QuestionItem(type="multiple_choice", difficulty=diff, question=q, options=opts, correct_answer=ans,
                            explanation=exp, sources=["Bài 1"]).model_dump()
        db.add(QuestionBankItem(teacher_id="gv-demo", course_id=COURSE_ID, lesson_id=LESSON_ID, payload=item,
                                original_payload=item, edited=False, status="approved", reviewed_by="gv-demo"))
    db.commit()

    course = course_admin.create_course(db, teacher, COURSE_ID, "Lập trình hướng đối tượng",
                                        "Nhập môn OOP với Python: lớp, đối tượng và 4 tính chất.", None)
    ch1 = course_admin.add_chapter(db, course, "Chương 1 · Lập trình hướng đối tượng")
    l1 = course_admin.add_lesson(db, ch1, LESSON_ID, "Bài 1: Lớp, đối tượng và 4 tính chất",
                                 "Lớp và đối tượng, đóng gói, kế thừa, đa hình, trừu tượng.")
    course_admin.add_item(db, teacher, l1, {"type": "video", "title": "Lớp, đối tượng và 4 tính chất", "video_id": VIDEO_ID})
    course_admin.add_item(db, teacher, l1, {"type": "slide", "title": "Slide: 4 tính chất của OOP",
                                            "document_id": slide_doc.id,
                                            "notes": "Nhấn mạnh: ghi đè là đa hình lúc chạy, nạp chồng là lúc biên dịch."})
    reading = course_admin.add_item(db, teacher, l1, {"type": "reading", "title": "Bài đọc: Lớp và đối tượng trong Python",
                                                      "content_md": (SAMPLE / "lesson_oop.md").read_text(encoding="utf-8")})
    if reading_doc and not reading.document_id:
        reading.document_id = reading_doc.id
        db.commit()
    course_admin.add_item(db, teacher, l1, {"type": "quiz", "title": "Kiểm tra cuối bài", "count": 5, "pass_ratio": 0.8})
    ch2 = course_admin.add_chapter(db, course, "Chương 2 · Quan hệ giữa các lớp")
    l2 = course_admin.add_lesson(db, ch2, "lesson-oop-02", "Bài 2: Kết tập, hợp thành và nguyên tắc thiết kế",
                                 "Quan hệ has-a, composition over inheritance.")
    course_admin.add_item(db, teacher, l2, {"type": "reading", "title": "Bài đọc: Quan hệ giữa các lớp",
                                            "content_md": "# Quan hệ giữa các lớp\n\nNgoài kế thừa (quan hệ is-a), các lớp còn có quan hệ "
                                                          "kết hợp \"có một\" (has-a).\n\n## Kết tập (aggregation)\n\nĐối tượng thành phần có thể "
                                                          "tồn tại độc lập với đối tượng chứa nó, ví dụ lớp học có các sinh viên.\n\n## Hợp thành "
                                                          "(composition)\n\nĐối tượng thành phần bị hủy khi đối tượng chứa bị hủy, ví dụ ngôi nhà "
                                                          "và các phòng.\n\n## Nguyên tắc\n\nƯu tiên hợp thành hơn kế thừa khi quan hệ không thực sự là \"là một\"."})
    print("• Khóa học demo: 2 chương, bài 1 có video + slide + bài đọc + kiểm tra")


DEMO_PASSWORD = "Demo@2026"
DEMO_ACCOUNTS = [
    ("admin", "Quản trị viên", "admin", []),
    ("gv-demo", "Cô Lan (giáo viên demo)", "teacher", ["CS101"]),
    ("sv-01", "Minh An", "student", ["CS101"]),
    ("sv-02", "Bảo Châu", "student", ["CS101"]),
]


def seed_accounts() -> None:
    """Lớp CS101 + tài khoản demo (cùng mật khẩu DEMO_PASSWORD). Đổi mật khẩu trước khi cho người khác dùng."""
    from app.core.passwords import hash_password
    from app.models.accounts import ClassRoom, User
    from app.services.accounts import _new_code, _sync_profile

    db = SessionLocal()
    try:
        if not db.get(ClassRoom, "CS101"):
            db.add(ClassRoom(class_id="CS101", name="Lập trình hướng đối tượng - CS101", join_code=_new_code(db),
                             created_by="seed"))
        created = []
        for uid, name, role, classes in DEMO_ACCOUNTS:
            if db.get(User, uid):
                continue
            u = User(user_id=uid, display_name=name, role=role, class_ids=classes, created_by="seed",
                     password_hash=hash_password(DEMO_PASSWORD), must_change_password=False)
            db.add(u)
            _sync_profile(db, u)
            created.append(uid)
        db.commit()
        code = db.get(ClassRoom, "CS101").join_code
        if created:
            print(f"• Tài khoản demo ({', '.join(created)}), mật khẩu: {DEMO_PASSWORD}  — mã vào lớp CS101: {code}")
        else:
            print(f"• Tài khoản demo đã có. Mã vào lớp CS101: {code}")
    finally:
        db.close()


def create_admin(username: str) -> None:
    import getpass

    from app.core.errors import AppError
    from app.core.passwords import check_policy, hash_password
    from app.models.accounts import User
    from app.services.accounts import _sync_profile, normalize_username

    try:
        uid = normalize_username(username)
        pw = getpass.getpass(f"Mật khẩu cho {uid}: ")
        if pw != getpass.getpass("Nhập lại mật khẩu: "):
            print("Hai lần nhập không khớp.")
            sys.exit(1)
        check_policy(pw, uid)
    except AppError as e:
        print("Lỗi:", e.detail)
        sys.exit(1)
    db = SessionLocal()
    try:
        u = db.get(User, uid)
        if u is None:
            u = User(user_id=uid, display_name="Quản trị viên", class_ids=[], created_by="cli")
            db.add(u)
        u.role, u.is_active, u.must_change_password = "admin", True, False
        u.password_hash = hash_password(pw)
        u.token_version = int(u.token_version or 0) + 1
        _sync_profile(db, u)
        db.commit()
        print(f"Đã sẵn sàng tài khoản quản trị: {uid}")
    finally:
        db.close()


def main() -> None:
    setup_logging(logging.WARNING)
    p = argparse.ArgumentParser()
    p.add_argument("--reset", action="store_true")
    p.add_argument("--seed", action="store_true")
    p.add_argument("--reembed", action="store_true")
    p.add_argument("--create-admin", metavar="USERNAME")
    args = p.parse_args()

    if args.reset:
        reset()
    if args.reembed:
        with engine.connect() as conn:
            current = embedding_dim_in_db(conn)
        if current and current != settings.embedding_dim:
            change_embedding_dim(settings.embedding_dim)
            print(f"Đã đổi vector({current}) -> vector({settings.embedding_dim})")
        else:
            with engine.begin() as conn:
                conn.execute(text("UPDATE ai_chunks SET embedding = NULL"))
    report = migrate(verbose=False)
    print("DB initialized.")
    for k in ("added_columns", "changed_types"):
        if report.get(k):
            print(f"  {k}: {', '.join(report[k])}")
    if report.get("warning"):
        print("  CẢNH BÁO:", report["warning"])
    if args.reembed:
        from app.services.ingestion import reembed_all
        db = SessionLocal()
        try:
            print(f"Đã tạo lại embedding cho {reembed_all(db)} chunk.")
        finally:
            db.close()
    if args.seed:
        seed()
        seed_accounts()
    if args.create_admin:
        create_admin(args.create_admin)


if __name__ == "__main__":
    main()
