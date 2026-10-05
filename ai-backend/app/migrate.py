"""Đồng bộ schema database một cách idempotent (chạy lại nhiều lần an toàn).

- Tạo bảng mới, thêm cột còn thiếu vào bảng cũ, đổi kiểu một số cột (UUID -> chuỗi cho mã LMS),
  backfill dữ liệu cũ, tạo index (gồm HNSW cho vector).
- Dùng cho cả DB mới và DB đã tạo từ phiên bản trước của dự án.
"""
import logging

from sqlalchemy import inspect, text

import app.models  # noqa: F401  (nạp toàn bộ model vào Base.metadata)
from app.config import settings
from app.database import Base, engine

log = logging.getLogger("app.migrate")

# (bảng, cột, kiểu đích, các data_type cũ cần đổi)
TYPE_FIXES = [
    ("ai_documents", "course_id", "varchar(128)", {"uuid"}),
    ("ai_documents", "class_id", "varchar(128)", {"uuid"}),
    ("ai_documents", "lesson_id", "varchar(128)", {"uuid"}),
    ("ai_conversations", "lesson_id", "varchar(128)", {"uuid"}),
    ("ai_generations", "lesson_id", "varchar(128)", {"uuid"}),
    ("ai_chunks", "start_time", "double precision", {"integer"}),
    ("ai_chunks", "end_time", "double precision", {"integer"}),
]

INDEXES = [
    "CREATE INDEX IF NOT EXISTS ix_docs_scope ON ai_documents (course_id, lesson_id, status)",
    "CREATE INDEX IF NOT EXISTS ix_docs_source ON ai_documents (source_type, source_id)",
    "CREATE INDEX IF NOT EXISTS ix_chunks_doc_idx ON ai_chunks (document_id, chunk_index)",
    "CREATE INDEX IF NOT EXISTS ix_segments_time ON transcript_segments (transcript_id, start_time)",
    "CREATE INDEX IF NOT EXISTS ix_transcripts_active ON video_transcripts (video_id, is_active)",
    "CREATE INDEX IF NOT EXISTS ix_vq_player ON video_questions (video_id, status, timestamp)",
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_video_session ON video_sessions (student_id, video_id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email ON users (lower(email)) WHERE email IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS ix_users_classes ON users USING gin (class_ids)",
    "CREATE INDEX IF NOT EXISTS ix_sessions_waiting ON video_sessions (current_state, question_deadline_at)",
]


def _column_type(conn, table: str, column: str) -> str | None:
    row = conn.execute(
        text("SELECT data_type FROM information_schema.columns WHERE table_name=:t AND column_name=:c"),
        {"t": table, "c": column},
    ).first()
    return row[0] if row else None


def embedding_dim_in_db(conn) -> int | None:
    row = conn.execute(text(
        "SELECT atttypmod FROM pg_attribute WHERE attrelid = 'ai_chunks'::regclass AND attname = 'embedding'"
    )).first()
    return int(row[0]) if row and row[0] and row[0] > 0 else None


def add_missing_columns(conn) -> list[str]:
    insp = inspect(conn)
    added = []
    for table in Base.metadata.sorted_tables:
        if not insp.has_table(table.name):
            continue
        existing = {c["name"] for c in insp.get_columns(table.name)}
        for col in table.columns:
            if col.name in existing:
                continue
            col_type = col.type.compile(dialect=conn.dialect)
            default = ""
            if col.server_default is not None and hasattr(col.server_default, "arg"):
                arg = col.server_default.arg
                default = f" DEFAULT {arg.text if hasattr(arg, 'text') else arg}"
            conn.execute(text(f'ALTER TABLE {table.name} ADD COLUMN IF NOT EXISTS "{col.name}" {col_type}{default}'))
            added.append(f"{table.name}.{col.name}")
    return added


def fix_column_types(conn) -> list[str]:
    changed = []
    for table, column, target, old_types in TYPE_FIXES:
        current = _column_type(conn, table, column)
        if current in old_types:
            conn.execute(text(f'ALTER TABLE {table} ALTER COLUMN "{column}" TYPE {target} USING "{column}"::{target}'))
            changed.append(f"{table}.{column}: {current} -> {target}")
    return changed


def backfill(conn) -> None:
    conn.execute(text("UPDATE ai_documents SET version = 1 WHERE version IS NULL"))
    conn.execute(text("UPDATE ai_documents SET is_active = (status <> 'deleted') WHERE is_active IS NULL"))
    conn.execute(text("UPDATE video_transcripts SET version = 1 WHERE version IS NULL"))
    conn.execute(text("UPDATE video_transcripts SET source = 'import' WHERE source IS NULL"))
    # Mỗi video chỉ một transcript active: bản mới nhất
    conn.execute(text("""
        UPDATE video_transcripts t SET is_active = (t.id = latest.id)
        FROM (SELECT DISTINCT ON (video_id) video_id, id FROM video_transcripts
              ORDER BY video_id, created_at DESC) latest
        WHERE t.video_id = latest.video_id AND t.is_active IS NULL
    """))
    conn.execute(text("UPDATE video_questions SET origin = 'teacher' WHERE origin IS NULL"))
    conn.execute(text("UPDATE video_sessions SET state_changed_at = COALESCE(updated_at, now()) WHERE state_changed_at IS NULL"))
    # Gộp phiên trùng (student, video) trước khi tạo unique index
    conn.execute(text("""
        DELETE FROM video_sessions s USING video_sessions d
        WHERE s.student_id = d.student_id AND s.video_id = d.video_id
          AND (s.created_at < d.created_at OR (s.created_at = d.created_at AND s.id < d.id))
    """))
    # Tính correct_index cho câu hỏi trắc nghiệm cũ
    from app.core.utils import resolve_option_index
    rows = conn.execute(text(
        "SELECT id, options, answer FROM video_questions "
        "WHERE correct_index IS NULL AND type IN ('multiple_choice','true_false') AND options IS NOT NULL"
    )).all()
    for qid, options, answer in rows:
        idx = resolve_option_index(options, answer)
        if idx is not None:
            conn.execute(text("UPDATE video_questions SET correct_index = :i WHERE id = :id"), {"i": idx, "id": qid})


def backfill_classes(conn) -> None:
    """Tạo bản ghi lớp cho các mã lớp đang được dùng (dữ liệu từ trước khi có bảng classes)."""
    conn.execute(text("""
        INSERT INTO classes (class_id, name, join_code, is_active, created_by)
        SELECT cid, cid, upper(substr(md5(random()::text || cid), 1, 6)), true, 'migrate'
        FROM (
            SELECT class_id AS cid FROM courses WHERE class_id IS NOT NULL
            UNION SELECT class_id FROM ai_documents WHERE class_id IS NOT NULL
            UNION SELECT class_id FROM media_videos WHERE class_id IS NOT NULL
            UNION SELECT jsonb_array_elements_text(class_ids) FROM users WHERE jsonb_typeof(class_ids) = 'array'
        ) x
        WHERE cid <> '' AND length(cid) <= 64
        ON CONFLICT DO NOTHING
    """))


def ensure_vector_index(conn) -> None:
    conn.execute(text(
        "CREATE INDEX IF NOT EXISTS ix_chunks_embedding_hnsw ON ai_chunks USING hnsw (embedding vector_cosine_ops)"
    ))


def migrate(verbose: bool = True) -> dict:
    report: dict = {}
    with engine.begin() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    Base.metadata.create_all(bind=engine)
    with engine.begin() as conn:
        report["added_columns"] = add_missing_columns(conn)
        report["changed_types"] = fix_column_types(conn)
        backfill(conn)
        backfill_classes(conn)
        for sql in INDEXES:
            conn.execute(text(sql))
        dim = embedding_dim_in_db(conn)
        report["embedding_dim_db"] = dim
        if dim and dim != settings.embedding_dim:
            report["warning"] = (
                f"Cột ai_chunks.embedding đang là vector({dim}) nhưng EMBEDDING_DIM={settings.embedding_dim}. "
                "Chạy `python init_db.py --reembed` để đổi kích thước và tạo lại embedding."
            )
        else:
            ensure_vector_index(conn)
    if verbose:
        for k, v in report.items():
            log.info("migrate", extra={"extra_fields": {k: v}})
    return report


def change_embedding_dim(new_dim: int) -> None:
    """Đổi kích thước vector (khi đổi model embedding). Embedding cũ bị xóa, cần tạo lại."""
    with engine.begin() as conn:
        conn.execute(text("DROP INDEX IF EXISTS ix_chunks_embedding_hnsw"))
        conn.execute(text("UPDATE ai_chunks SET embedding = NULL"))
        conn.execute(text(f"ALTER TABLE ai_chunks ALTER COLUMN embedding TYPE vector({int(new_dim)})"))
        ensure_vector_index(conn)
