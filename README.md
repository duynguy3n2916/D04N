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
| Backend | Python 3.10+, FastAPI, SQLAlchemy 2, PostgreSQL cloud (**Neon**) + **pgvector** |
| Lưu trữ file | **Cloudflare R2** (tài liệu, video, ảnh bìa khóa học); có thể chuyển về thư mục local (`MEDIA_STORAGE=local`) |
| AI | OpenAI qua LLM Gateway (chat, sinh câu hỏi, chấm); embedding `paraphrase-multilingual-MiniLM-L12-v2` (chạy local); Whisper (Groq hoặc OpenAI) |
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
│   │   └── services/      # nghiệp vụ: retrieval, tutor, workflow video, learning, accounts, lưu trữ file (object_store)...
│   ├── sample_data/       # dữ liệu demo: bài OOP, video + phụ đề, slide PDF, bộ câu hỏi đánh giá
│   ├── tests/             # pytest (Postgres thật trên cloud, LLM giả lập)
│   ├── init_db.py         # tạo / nâng cấp database, nạp dữ liệu demo, tạo tài khoản quản trị
│   ├── Dockerfile         # đóng gói backend (tùy chọn)
│   └── docker-compose.yml # chạy backend trong Docker (tùy chọn, profile full); DB không nằm trong compose
├── frontend/              # React + TypeScript (bản build sẵn ở frontend/dist)
├── architecture.md        # tài liệu kiến trúc
└── Ke_hoach_xay_dung_he_thong_AI_ho_tro_hoc_tap.docx
```

---

## Chạy thử

Yêu cầu: **Python 3.10+** và một database **PostgreSQL có pgvector** trên cloud (dự án dùng **Neon**).
Không cần Docker để chạy hệ thống. Node.js **không bắt buộc** — giao diện đã build sẵn.

```bash
cd ai-backend

# 1. Cấu hình
copy .env.example .env          # macOS/Linux: cp .env.example .env
#    Mở .env và điền:
#    - DATABASE_URL: chuỗi kết nối Neon (direct connection, có sslmode=require)
#    - OPENAI_API_KEY (chat, sinh câu hỏi); GROQ_API_KEY nếu dùng phiên âm Whisper
#    - MEDIA_STORAGE=r2 cùng R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
#    - JWT_SECRET: chuỗi ngẫu nhiên >= 32 ký tự:
#      python -c "import secrets; print(secrets.token_urlsafe(48))"

# 2. Thư viện + khởi tạo schema + dữ liệu demo
pip install -r requirements.txt
python init_db.py --seed

# 3. Chạy
uvicorn app.main:app --reload --port 8000
```

Khi khởi động, app tự tạo extension `vector` và đồng bộ schema (xem `app/migrate.py`).

Mở **http://localhost:8000** (giao diện) — tài liệu API: http://localhost:8000/docs

**Tài khoản demo** (tạo bởi `--seed`), mật khẩu chung `Demo@2026`:

| Tài khoản | Vai trò |
|---|---|
| `admin` | Quản trị |
| `gv-demo` | Giáo viên lớp CS101 |
| `sv-01`, `sv-02` | Học sinh lớp CS101 |

Đổi mật khẩu các tài khoản này trước khi cho người khác dùng. Tạo tài khoản quản trị riêng: `python init_db.py --create-admin admin`.

> **Lỗi “KHÔNG KẾT NỐI ĐƯỢC POSTGRES”:** kiểm tra `DATABASE_URL` trong `.env` (đúng host, mật khẩu, `sslmode=require`) và kết nối mạng.
> Nếu thiếu `DATABASE_URL`, app dừng ngay khi khởi động và báo lỗi rõ ràng.
> Nếu `MEDIA_STORAGE=r2` mà thiếu biến `R2_*`, app báo lỗi khi cần đọc hoặc ghi file.

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
pytest
```

Test chạy trên một **database Postgres riêng**, không bao giờ trên database production. Đặt `TEST_DATABASE_URL` trong `.env`:
tên database phải chứa chữ `test` và không được trùng `DATABASE_URL`, nếu không test sẽ từ chối chạy. Mỗi lần chạy, test xóa
schema `public` của database test rồi tạo lại (không tạo hay xóa database).

---

## Cấu hình chính (`ai-backend/.env`)

| Biến | Ý nghĩa |
|---|---|
| `DATABASE_URL` | chuỗi kết nối Postgres cloud (Neon) — bắt buộc |
| `TEST_DATABASE_URL` | database riêng để chạy `pytest` (tên có chữ `test`) |
| `OPENAI_API_KEY`, `OPENAI_LLM_MODEL` | khóa và model cho LLM (mặc định `gpt-4o-mini`); LLM chỉ dùng OpenAI |
| `EMBEDDING_PROVIDER` | `local` (mặc định, không cần key) hoặc `openai` |
| `WHISPER_PROVIDER`, `GROQ_API_KEY` | phiên âm video (`groq` mặc định) |
| `MEDIA_STORAGE` | `r2` (Cloudflare R2) hoặc `local` (thư mục `STORAGE_PATH`) |
| `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | thông tin bucket R2, dùng khi `MEDIA_STORAGE=r2` |
| `JWT_SECRET` | chuỗi bí mật ký phiên đăng nhập (bắt buộc đổi) |
| `ALLOW_REGISTRATION` | cho học sinh tự đăng ký |
| `LOGIN_HINT` | dòng gợi ý dưới form đăng nhập (vd: tài khoản demo khi bảo vệ đồ án) |
| `QUESTION_TIMEOUT_SECONDS` | thời gian trả lời câu hỏi trong video (mặc định 120) |
| `AGENT_COOLDOWN_SECONDS` | khoảng nghỉ giữa hai lần AI hỏi (mặc định 300) |
| `RAG_MIN_SCORE` | ngưỡng liên quan để Tutor từ chối khi học liệu không đủ |
| `QUIZ_GUARD_MINUTES` | bài kiểm tra làm dở trong khoảng này thì Tutor chỉ gợi ý, không nói đáp án (mặc định 90) |
| `REDACT_PII` | che email / số điện thoại trong câu hỏi trước khi lưu và gửi LLM (mặc định bật) |
| `CHAT_RETENTION_DAYS`, `LLM_LOG_RETENTION_DAYS` | thời hạn lưu tin nhắn Tutor / nhật ký gọi LLM, 0 = giữ mãi (mặc định 365 / 180) |

Không commit file `.env` (đã có trong `.gitignore`).

---

## Tài liệu

- [`architecture.md`](architecture.md) — yêu cầu chức năng, kiến trúc, state machine video, thiết kế dữ liệu, API, bảo mật, đánh giá.
- [`ai-backend/README.md`](ai-backend/README.md) — chi tiết backend, danh mục API, lệnh tiện ích.
