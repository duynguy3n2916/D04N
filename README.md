# D04N — Hệ thống AI hỗ trợ học tập

Nền tảng học trực tuyến có AI kèm cặp: học sinh xem video bài giảng, slide, bài đọc và làm bài kiểm tra theo lộ trình;
**Tutor AI** trả lời câu hỏi dựa trên đúng học liệu của bài (có trích nguồn); video **tự dừng để hỏi** học sinh và AI giải
thích đáp án; giáo viên dùng AI để soạn câu hỏi và quản lý lớp học.

> Đồ án — thiết kế chi tiết xem [`architecture.md`](architecture.md), kế hoạch ban đầu xem
> `Ke_hoach_xay_dung_he_thong_AI_ho_tro_hoc_tap.docx`.

---

## Tính năng

### Học sinh
- **Lộ trình học** theo chương → bài → mục (video, slide, bài đọc, kiểm tra); mục sau mở khi xong mục trước.
- **Trang bài học 3 cột:** mục lục · nội dung · khung chat **Tutor AI** (bật/tắt bằng nút “Hỏi Tutor AI”).
- **Video bài giảng:** phụ đề, tốc độ phát, ghi chú; chế độ khung vừa / rộng / toàn màn hình.
  - Tới mốc câu hỏi của giáo viên, video **tạm dừng và hiện popup**: chọn đáp án → Kiểm tra → xem giải thích → “Xem tiếp video”.
  - **Câu hỏi mở rộng của AI** (tùy chọn): *Question Agent* tự đặt câu hỏi từ đoạn vừa xem; khi học sinh hết giờ hoặc trả lời sai,
    *Tutor AI* (AI thứ hai) đọc lại lời giảng + học liệu và giải thích vì sao đáp án đúng.
- **Slide** (PDF xem trực tiếp, PPTX dạng chữ) và **bài đọc** Markdown có mục lục; bôi đen đoạn văn để hỏi Tutor.
- **Bài kiểm tra** cuối bài từ ngân hàng câu hỏi đã duyệt.
- **XP, chuỗi ngày học, mục tiêu ngày, bảng xếp hạng tuần.**
- Nguồn Tutor trích dẫn bấm được: tua video tới đúng giây, mở slide đúng trang.

### Giáo viên / quản trị
- Tạo khóa học và bài học bằng tên; hệ thống tự sinh mã. Khi thêm video, chọn khóa học → bài học để gắn trực tiếp, hoặc lưu vào thư viện.
- Khi AI soạn câu hỏi, chọn rõ các nguồn video / bài đọc / slide. Slide hoặc bài đọc đã bỏ khỏi bài không còn được dùng làm nguồn của bài đó; file vẫn có thể lưu trong thư viện để dùng lại.
- Soạn khóa học (chương, bài, mục học), tải video, phiên âm (Whisper) hoặc nhập phụ đề `.srt/.vtt`, sửa phụ đề có phiên bản.
- **AI soạn câu hỏi** theo mốc video hoặc theo bài; ngân hàng câu hỏi với quy trình sửa / duyệt / từ chối.
- Quản lý học liệu (Knowledge Base), xem các đoạn đã chia để Tutor truy xuất.
- **Tài khoản & lớp học:** tạo lớp có mã vào lớp, thêm học sinh hoặc nhập CSV, cấp lại mật khẩu, khóa tài khoản, phân quyền.
- **Đánh giá Tutor** định lượng (Hit@K, MRR, độ bám nguồn, từ chối đúng, độ trễ) và theo dõi chi phí / độ trễ các lượt gọi LLM.

---

## Công nghệ

| Phần | Công nghệ |
|---|---|
| Backend | Python 3.10+, FastAPI, SQLAlchemy 2, PostgreSQL 16 + **pgvector** |
| AI | Claude (mặc định) hoặc OpenAI qua LLM Gateway; embedding `paraphrase-multilingual-MiniLM-L12-v2` (chạy local); Whisper (Groq/OpenAI) |
| Frontend | React 19 + TypeScript + Vite, pdf.js, marked + DOMPurify |
| Bảo mật | Tài khoản riêng, mật khẩu băm scrypt, JWT, phân quyền học sinh / giáo viên / quản trị theo lớp |

---

## Cấu trúc thư mục

```
D04N/
├── ai-backend/            # FastAPI: API, RAG, Tutor, Question Agent, đánh giá
│   ├── app/
│   │   ├── core/          # bảo mật, mật khẩu, prompt, lỗi, schema LLM
│   │   ├── models/        # bảng dữ liệu (SQLAlchemy)
│   │   ├── routers/       # các nhóm API /ai/*
│   │   └── services/      # nghiệp vụ: retrieval, tutor, workflow video, learning, accounts...
│   ├── sample_data/       # dữ liệu demo: bài OOP, video + phụ đề, slide PDF, bộ câu hỏi đánh giá
│   ├── tests/             # pytest (Postgres thật, LLM giả lập)
│   ├── init_db.py         # tạo / nâng cấp database, nạp dữ liệu demo, tạo tài khoản quản trị
│   └── docker-compose.yml # Postgres + pgvector
├── frontend/              # React + TypeScript (bản build sẵn ở frontend/dist)
├── architecture.md        # tài liệu kiến trúc
└── Ke_hoach_xay_dung_he_thong_AI_ho_tro_hoc_tap.docx
```

---

## Chạy thử

Yêu cầu: **Python 3.10+**, **Docker Desktop** (để chạy Postgres + pgvector). Node.js **không bắt buộc** — giao diện đã build sẵn.

```bash
cd ai-backend

# 1. Cấu hình
copy .env.example .env          # macOS/Linux: cp .env.example .env
#    Mở .env: điền CLAUDE_API_KEY (hoặc OPENAI_API_KEY), GROQ_API_KEY nếu cần phiên âm,
#    và đặt JWT_SECRET là chuỗi ngẫu nhiên >= 32 ký tự:
#    python -c "import secrets; print(secrets.token_urlsafe(48))"

# 2. Database (Postgres 16 + pgvector ở cổng 5433)
docker compose up -d

# 3. Thư viện + tạo database + dữ liệu demo
pip install -r requirements.txt
python init_db.py --seed

# 4. Chạy
uvicorn app.main:app --reload --port 8000
```

Mở **http://localhost:8000** (giao diện) — tài liệu API: http://localhost:8000/docs

**Tài khoản demo** (tạo bởi `--seed`), mật khẩu chung `Demo@2026`:

| Tài khoản | Vai trò |
|---|---|
| `admin` | Quản trị |
| `gv-demo` | Giáo viên lớp CS101 |
| `sv-01`, `sv-02` | Học sinh lớp CS101 |

Đổi mật khẩu các tài khoản này trước khi cho người khác dùng. Tạo tài khoản quản trị riêng: `python init_db.py --create-admin admin`.

> **Lỗi “KHÔNG KẾT NỐI ĐƯỢC POSTGRES” / `Connection refused` cổng 5433:** Docker Desktop chưa chạy hoặc chưa
> `docker compose up -d`. Kiểm tra bằng `docker compose ps` (trạng thái phải là *healthy*).

### Sửa giao diện (tùy chọn)

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173/app/  (gọi API qua proxy tới backend :8000)
npm run build    # build lại frontend/dist
```

### Kiểm thử

```bash
cd ai-backend
pip install -r requirements-dev.txt
pytest           # cần Postgres; đặt TEST_DATABASE_URL nếu khác mặc định
```

---

## Cấu hình chính (`ai-backend/.env`)

| Biến | Ý nghĩa |
|---|---|
| `LLM_PROVIDER` | `claude` hoặc `openai` |
| `CLAUDE_API_KEY` / `OPENAI_API_KEY` | khóa API của nhà cung cấp LLM |
| `EMBEDDING_PROVIDER` | `local` (mặc định, không cần key) hoặc `openai` |
| `WHISPER_PROVIDER`, `GROQ_API_KEY` | phiên âm video |
| `JWT_SECRET` | chuỗi bí mật ký phiên đăng nhập (bắt buộc đổi) |
| `ALLOW_REGISTRATION` | cho học sinh tự đăng ký |
| `LOGIN_HINT` | dòng gợi ý dưới form đăng nhập (vd: tài khoản demo khi bảo vệ đồ án) |
| `QUESTION_TIMEOUT_SECONDS` | thời gian trả lời câu hỏi trong video (mặc định 120) |
| `AGENT_COOLDOWN_SECONDS` | khoảng nghỉ giữa hai lần AI hỏi (mặc định 300) |
| `RAG_MIN_SCORE` | ngưỡng liên quan để Tutor từ chối khi học liệu không đủ |

Không commit file `.env` (đã có trong `.gitignore`).

---

## Tài liệu

- [`architecture.md`](architecture.md) — yêu cầu chức năng, kiến trúc, state machine video, thiết kế dữ liệu, API, bảo mật, đánh giá.
- [`ai-backend/README.md`](ai-backend/README.md) — chi tiết backend, danh mục API, lệnh tiện ích.
