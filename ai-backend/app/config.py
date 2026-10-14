from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Cấu hình hệ thống, đọc từ biến môi trường hoặc file .env."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- Database ---
    database_url: str = ""  # bắt buộc đặt trong .env: Postgres cloud (Neon), app không còn dùng DB local mặc định

    # --- LLM: OpenAI (hệ thống không còn gọi Claude) ---
    openai_api_key: str = ""
    openai_llm_model: str = "gpt-4o-mini"
    openai_embedding_model: str = "text-embedding-3-small"
    llm_timeout_seconds: float = 90.0
    # Đơn giá để ước tính chi phí (USD / 1 triệu token). Để 0 nếu không muốn ước tính.
    llm_price_input_per_mtok: float = 0.0
    llm_price_output_per_mtok: float = 0.0

    # --- Embedding: local | openai | hash (hash chỉ dùng cho kiểm thử, không có ngữ nghĩa) ---
    embedding_provider: str = "local"
    embedding_model: str = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
    embedding_dim: int = 384

    # --- Speech-to-Text: groq | openai ---
    whisper_provider: str = "groq"
    groq_api_key: str = ""
    groq_whisper_model: str = "whisper-large-v3-turbo"
    stt_chunk_seconds: int = 600  # cắt audio thành đoạn 10 phút trước khi gửi Whisper

    # --- Lưu trữ file: MEDIA_STORAGE=r2 (Cloudflare R2) | local (thư mục storage_path) ---
    media_storage: str = "local"
    storage_path: str = "./storage"
    r2_account_id: str = ""
    r2_bucket: str = ""
    r2_access_key_id: str = ""
    r2_secret_access_key: str = ""
    max_document_mb: int = 50
    max_media_mb: int = 500

    # --- Bảo mật ---
    jwt_secret: str = "dev-secret-change-me"
    jwt_algorithm: str = "HS256"
    jwt_ttl_minutes: int = 720
    allow_test_login: bool = False  # ALLOW_TEST_LOGIN=true: /ai/auth/demo-login cấp token không cần mật khẩu (CHỈ cho test tự động)
    allow_registration: bool = True  # học sinh tự tạo tài khoản ở màn hình đăng nhập
    allow_external_tokens: bool = False  # chấp nhận token do LMS ký cho người dùng chưa có tài khoản trong hệ thống
    login_hint: str = ""  # dòng gợi ý hiện dưới form đăng nhập (vd: tài khoản demo khi bảo vệ đồ án)
    cors_origins: str = "http://localhost:8000,http://127.0.0.1:8000,null"

    # --- Email (quên mật khẩu) ---
    smtp_host: str = ""  # để trống = tắt gửi email; khi đó giáo viên/admin cấp lại mật khẩu tạm
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = ""  # vd "D04N <no-reply@example.com>"
    smtp_starttls: bool = True
    smtp_ssl: bool = False  # cổng 465
    public_app_url: str = ""  # gốc giao diện cho link trong email, vd https://d04n.example.com/app ; trống = lấy từ request
    password_reset_ttl_minutes: int = 30

    # --- RAG ---
    rag_top_k: int = 5
    rag_min_score: float = 0.40  # cosine tối thiểu để coi là liên quan; hiệu chỉnh trên tập dev của bộ đánh giá demo
    rag_expand_neighbors: bool = True
    rag_max_context_chars: int = 9000
    rag_hybrid: bool = True  # kết hợp tìm vector với tìm từ khóa (Postgres full-text), hợp nhất bằng RRF
    rag_hybrid_min_coverage: float = 0.6  # chunk chỉ khớp từ khóa phải chứa >= 60% từ có nghĩa của câu hỏi
    rag_rerank: str = "none"  # none | cross_encoder (tải model ~470MB lần đầu)
    rag_rerank_model: str = "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1"
    rag_query_rewrite: str = "history"  # none | history: câu hỏi nối tiếp ngắn được ghép câu hỏi trước khi truy xuất
    rag_chunk_size: int = 800
    rag_chunk_overlap: int = 100
    chat_history_turns: int = 6
    chat_summary_after_messages: int = 16

    # --- Guardrail / lưu trữ ---
    quiz_guard_minutes: int = 90  # bài kiểm tra đang làm dở trong khoảng này thì Tutor chỉ gợi ý, không nói đáp án
    redact_pii: bool = True  # che email / số điện thoại trong câu hỏi trước khi lưu và gửi LLM
    chat_retention_days: int = 365  # xóa tin nhắn Tutor cũ hơn N ngày (0 = giữ mãi)
    llm_log_retention_days: int = 180  # xóa nhật ký ai_llm_calls cũ hơn N ngày (0 = giữ mãi)

    # --- Workflow / Video ---
    question_timeout_seconds: int = 120
    agent_cooldown_seconds: int = 300
    scheduled_question_proximity_seconds: float = 45.0
    agent_transcript_window_seconds: float = 75.0
    feedback_auto_resume_seconds: int = 600
    timeout_sweep_interval_seconds: int = 30

    # --- Jobs nền ---
    job_workers: int = 2

    # --- Học tập / gamification ---
    app_timezone: str = "Asia/Ho_Chi_Minh"  # dùng để tính "hôm nay" và chuỗi ngày học
    tutor_daily_limit_per_lesson: int = 15  # số lượt hỏi Tutor mỗi học sinh / bài / ngày (0 = không giới hạn)
    default_daily_goal_xp: int = 50
    xp_video_question: int = 10
    xp_agent_question: int = 15
    xp_item_complete: int = 5
    xp_quiz_question: int = 5
    xp_quiz_pass: int = 20

    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def llm_provider(self) -> str:
        return "openai"

    def current_llm_model(self) -> str:
        return self.openai_llm_model


settings = Settings()
