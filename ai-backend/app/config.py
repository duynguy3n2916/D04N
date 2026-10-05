from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Cấu hình hệ thống, đọc từ biến môi trường hoặc file .env."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- Database ---
    database_url: str = "postgresql://postgres:postgres@localhost:5433/ai_learning"

    # --- LLM: claude | openai ---
    llm_provider: str = "claude"
    claude_api_key: str = ""
    claude_base_url: str = ""  # để trống = endpoint mặc định của Anthropic SDK (https://api.anthropic.com)
    claude_llm_model: str = "claude-fable-5"
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

    # --- Lưu trữ file ---
    storage_path: str = "./storage"
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

    # --- RAG ---
    rag_top_k: int = 5
    rag_min_score: float = 0.30  # cosine similarity tối thiểu để coi là liên quan
    rag_expand_neighbors: bool = True
    rag_max_context_chars: int = 9000
    chat_history_turns: int = 6
    chat_summary_after_messages: int = 16

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
    default_daily_goal_xp: int = 50
    xp_video_question: int = 10
    xp_agent_question: int = 15
    xp_item_complete: int = 5
    xp_quiz_question: int = 5
    xp_quiz_pass: int = 20

    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    def current_llm_model(self) -> str:
        return self.claude_llm_model if self.llm_provider.lower() == "claude" else self.openai_llm_model


settings = Settings()
