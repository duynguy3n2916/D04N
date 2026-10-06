# AI Learning Support — Backend

Hệ thống AI hỗ trợ học tập: Knowledge Base + RAG, Tutor, Teacher AI, Speech-to-Text, AI Video Learning,
Question Agent điều phối bằng state machine, và đánh giá định lượng. Thiết kế chi tiết: `../architecture.md`.

## Chạy hệ thống (Windows / macOS / Linux)

```bash
# 1. Cấu hình
copy .env.example .env          # macOS/Linux: cp .env.example .env
#    điền CLAUDE_API_KEY (hoặc OPENAI_API_KEY), GROQ_API_KEY nếu dùng phiên âm, đổi JWT_SECRET

# 2. Database (Postgres 16 + pgvector, cổng 5433)
docker compose up -d

# 3. Thư viện + khởi tạo / nâng cấp DB + dữ liệu demo (kèm tài khoản demo)
pip install -r requirements.txt
python init_db.py --seed
#    hoặc chỉ tạo tài khoản quản trị (nhập mật khẩu ẩn):
python init_db.py --create-admin admin

# 4. Chạy
uvicorn app.main:app --reload --port 8000
```

- Giao diện web: http://localhost:8000 (tự chuyển tới `/app/`) — Swagger: http://localhost:8000/docs
- Tài khoản demo (tạo bởi `--seed`): `admin` (quản trị), `gv-demo` (giáo viên lớp CS101), `sv-01`, `sv-02` (học sinh CS101),
  cùng mật khẩu **`Demo@2026`** — đổi mật khẩu (trong Hồ sơ) trước khi cho người khác dùng. Mã vào lớp CS101 được in ra khi seed.
- Dữ liệu demo: khóa học **Lập trình hướng đối tượng** (2 chương), bài `lesson-oop-01`
  gồm video `video-01` (câu hỏi dừng video tại 01:35), slide PDF 8 trang, bài đọc và bài kiểm tra cuối bài.

## Giao diện (frontend/)

React 19 + TypeScript + Vite, phong cách “gamified” (nút nổi khối, XP, chuỗi ngày học, bảng xếp hạng).
Bản đã build nằm sẵn trong `frontend/dist` nên **không cần cài Node** để chạy — FastAPI phục vụ tại `/app/`.

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173/app/ — gọi /ai/* qua proxy tới backend :8000
npm run build      # build lại frontend/dist (backend tự phục vụ)
npm run typecheck
```

| Màn hình | Chức năng |
|---|---|
| Học (`#/learn`) | Lộ trình chương → bài → mục; mục sau mở khi xong mục trước; mục tiêu XP ngày, bảng xếp hạng tuần |
| Bài học (`#/lesson/...`) | Trái: mục lục bài · Giữa: video / slide / bài đọc / kiểm tra · Phải: khung **Tutor AI** (bật/tắt bằng nút “Hỏi Tutor AI”) |
| Video | Câu hỏi của giáo viên tự **dừng video + hiện popup**; chọn → Kiểm tra → giải thích; chỉ “Xem tiếp video” mới đóng và phát tiếp. Phụ đề, tốc độ, ghi chú, đánh dấu câu hỏi trên thanh thời gian |
| Slide | Xem PDF (pdf.js) từng trang / cuộn dọc, phóng to, ảnh thu nhỏ; PPTX hiển thị dạng chữ; Tutor biết trang đang xem |
| Bài đọc | Markdown + mục lục; bôi đen đoạn văn → “Hỏi Tutor về đoạn này” / “Thêm vào ghi chú” |
| Kiểm tra | Từng câu, phản hồi đúng/sai ngay, đạt ngưỡng thì qua bài và nhận XP |
| Giáo viên | Soạn khóa học, tải video + phiên âm/sửa phụ đề, AI soạn câu hỏi theo mốc video, ngân hàng câu hỏi, học liệu, đánh giá Tutor; admin xem chi phí/độ trễ LLM |

Nguồn mà Tutor trích dẫn bấm được: nguồn video tua tới đúng giây, nguồn slide mở đúng trang.
- **Nâng cấp từ phiên bản cũ:** chỉ cần chạy lại `python init_db.py` (hoặc khởi động server — server tự đồng bộ schema).
  Dữ liệu cũ được giữ; cột `lesson_id/course_id/class_id` chuyển sang dạng chuỗi để nhận mã LMS như `lesson-oop-01`.
- Chạy cả backend bằng Docker: `docker compose --profile full up -d --build`.

## Lệnh tiện ích

| Lệnh | Tác dụng |
|---|---|
| `python init_db.py` | Tạo bảng mới, thêm cột còn thiếu, tạo index (chạy lại an toàn) |
| `python init_db.py --seed` | Nạp dữ liệu demo + bộ 24 câu đánh giá |
| `python init_db.py --reembed` | Sau khi đổi model embedding / `EMBEDDING_DIM`: đổi kích thước vector và tạo lại embedding |
| `python init_db.py --reset` | Xóa toàn bộ dữ liệu AI (có hỏi xác nhận) |
| `pip install -r requirements-dev.txt && pytest` | Chạy 31 bài test (cần Postgres; đặt `TEST_DATABASE_URL` nếu khác `postgresql://postgres:postgres@localhost:5433/ai_pytest`) |

## Tài khoản & xác thực

- **Đăng nhập** bằng tên đăng nhập (hoặc email) + mật khẩu → JWT (`Authorization: Bearer <token>`). Mật khẩu băm **scrypt**
  (thư viện chuẩn Python), tối thiểu 8 ký tự, có chữ và số.
- **Vai trò:** `student` | `teacher` | `admin`. Vai trò, lớp và trạng thái tài khoản được đọc lại từ DB mỗi request, nên khóa
  tài khoản / đổi quyền có hiệu lực ngay. Đổi mật khẩu, cấp lại mật khẩu, “Đăng xuất mọi thiết bị” làm mọi token cũ mất hiệu lực.
- **Tự đăng ký** (bật bằng `ALLOW_REGISTRATION`): chỉ tạo được tài khoản học sinh; nhập **mã vào lớp** để vào lớp ngay.
- **Giáo viên** tạo lớp (nhận mã vào lớp), tạo tài khoản học sinh từng người hoặc **nhập CSV** (cột `username`/`mssv`,
  `display_name`/`ho_ten`, `class_ids`/`lop`, `email`, `password`), cấp lại mật khẩu tạm, khóa tài khoản — chỉ với học sinh lớp mình.
  **Admin** quản lý mọi tài khoản, phân vai trò.
- Tài khoản do giáo viên/admin tạo hoặc vừa được cấp lại mật khẩu sẽ **bắt buộc đổi mật khẩu** ở lần đăng nhập đầu.
- **Quên mật khẩu:** giáo viên hoặc admin cấp lại mật khẩu tạm (chưa gửi email tự động).
- **Tích hợp LMS (tùy chọn):** LMS ký JWT bằng cùng `JWT_SECRET`; đặt `ALLOW_EXTERNAL_TOKENS=true` để chấp nhận token của người
  dùng chưa có tài khoản trong hệ thống.
- Tài liệu / transcript / khóa học không gắn `class_id` thì mọi người dùng thấy; gắn lớp thì chỉ thành viên lớp (hoặc admin) thấy.

**Nâng cấp từ bản trước:** xóa dòng `ALLOW_DEMO_LOGIN` trong `.env` (đăng nhập không mật khẩu đã bỏ), đặt `JWT_SECRET`
ngẫu nhiên ≥ 32 ký tự, chạy `python init_db.py` rồi `python init_db.py --create-admin admin`. Tiến độ học cũ gắn theo mã người
dùng, nên tạo tài khoản trùng mã cũ (ví dụ `sv-01`) là giữ được tiến độ.

## Cấu trúc

```
app/
  main.py            # FastAPI, middleware request_id, tự migrate, job runner, quét timeout nền
  config.py          # cấu hình (.env)
  migrate.py         # đồng bộ schema idempotent
  core/              # security (JWT, vai trò, tra tài khoản mỗi request), passwords (scrypt), errors, prompts (có version), llm_schemas (Pydantic), utils
  models/            # 17 bảng (xem architecture.md §9)
  services/
    llm.py           # LLM Gateway: Claude/OpenAI, validate JSON + tự sửa 1 lần, log ai_llm_calls
    retrieval.py     # RAG Engine: lọc phạm vi + lớp, pgvector, ngưỡng điểm, mở rộng lân cận, nhãn nguồn [S1]
    tutor_explain.py # Tutor tự giải thích đáp án khi học sinh hết giờ / trả lời sai (AI thứ hai, chạy nền)
    tutor.py         # Tutor: lịch sử + tóm tắt, transcript quanh video_time, hint mode do server quyết, chặn lộ đáp án
    question_gen.py  # Teacher AI: sinh đề, ngân hàng câu hỏi, duyệt từng câu, tỷ lệ chấp nhận
    transcription.py # phụ đề / Whisper (ffmpeg cắt đoạn), phiên bản transcript, index KB
    video_learning.py# câu hỏi theo mốc, AI đề xuất mốc, duyệt câu hỏi video
    workflow.py      # state machine + Question Agent (khóa dòng, deadline phía server, nhật ký transition)
    grading.py       # chấm trắc nghiệm theo chỉ số lựa chọn, tự luận bằng LLM (có dự phòng)
    evaluation.py    # Hit@K/MRR/Recall theo nguồn đúng, groundedness/correctness (judge), latency, chi phí, WER
    jobs.py          # job nền trong tiến trình (ingest, phiên âm, evaluation) + bảng ai_jobs
    accounts.py      # đăng nhập/đăng ký, đổi mật khẩu, quản lý tài khoản, nhập CSV, lớp học + mã vào lớp
    learning.py      # lộ trình học: trạng thái mục (khóa tuần tự), tiến độ, XP/chuỗi ngày/bảng xếp hạng, quiz cuối bài
    course_admin.py  # soạn khóa học: chương, bài, mục (video/slide/bài đọc/kiểm tra), bài đọc tự nạp vào Knowledge Base
  routers/           # auth, users, documents, chat, teacher, videos, workflow, evaluation, jobs, admin, learn, media
sample_data/         # bài học OOP, phụ đề video-01, bộ câu hỏi đánh giá
tests/               # pytest với Postgres thật, LLM giả lập
```

## API chính

| Nhóm | Endpoint |
|---|---|
| Tài khoản | `GET /ai/auth/config`, `POST /ai/auth/login`, `POST /ai/auth/register`, `GET/PATCH /ai/auth/me`, `POST /ai/auth/change-password`, `POST /ai/auth/logout-all`, `POST /ai/auth/join-class`, `POST /ai/auth/leave-class/{class_id}` |
| Người dùng & lớp | `GET/POST /ai/users`, `POST /ai/users/import`, `PATCH /ai/users/{id}`, `POST /ai/users/{id}/reset-password`, `GET/POST /ai/classes`, `PATCH /ai/classes/{id}` |
| Học liệu | `POST /ai/documents/index` (202 + job), `POST /ai/lessons/{lesson_id}/index`, `GET /ai/documents`, `GET /ai/documents/{id}[/chunks]`, `DELETE /ai/documents/{id}` |
| Job | `GET /ai/jobs/{job_id}`, `GET /ai/jobs` |
| Tutor | `POST /ai/chat`, `POST /ai/retrieve`, `GET /ai/conversations[/{id}]` |
| Teacher AI | `POST /ai/teacher/generate-quiz`, `POST /ai/questions/generate`, `GET /ai/teacher/question-bank`, `PATCH /ai/question-bank/{id}`, `GET /ai/teacher/generations`, `PATCH /ai/teacher/generations/{id}`, `GET /ai/teacher/stats` |
| Transcript | `POST /ai/videos/import-transcript`, `POST /ai/videos/transcribe` (202 + job), `GET/PUT /ai/videos/{id}/transcript`, `GET .../transcript/versions`, `POST .../transcript/rollback/{version}` |
| Câu hỏi video | `POST /ai/videos/{id}/generate-question`, `POST /ai/videos/{id}/suggest-timestamps`, `POST /ai/videos/{id}/questions`, `GET /ai/videos/{id}/questions` (học sinh, không đáp án), `GET .../questions/manage`, `PATCH/DELETE /ai/video-questions/{id}`, `POST /ai/video-questions/{id}/answer` |
| Workflow | `POST /ai/workflow/question-start`, `POST /ai/question-agent/trigger`, `POST /ai/workflow/timeout`, `POST /ai/workflow/resume`, `GET /ai/workflow/session?video_id=` |
| Evaluation | `GET/POST /ai/evaluation/samples`, `POST /ai/evaluation/run` (202 + job), `GET /ai/evaluation/latest`, `GET /ai/evaluation/runs[/{id}][/report.md]`, `POST /ai/evaluation/wer` |
| Học (học sinh) | `GET /ai/learn/me`, `PUT /ai/learn/goal`, `GET /ai/learn/leaderboard`, `GET /ai/learn/courses[/{id}]`, `GET /ai/learn/lessons/{id}`, `GET /ai/learn/items/{id}`, `POST .../position`, `POST .../complete`, `POST .../quiz/start|answer|finish`, `GET /ai/learn/locate` |
| Soạn khóa học | `GET/POST /ai/courses`, `GET/PATCH/DELETE /ai/courses/{id}`, `POST /ai/courses/{id}/chapters`, `PATCH/DELETE /ai/chapters/{id}`, `POST /ai/chapters/{id}/lessons`, `PATCH/DELETE /ai/lessons/{id}`, `POST /ai/lessons/{id}/items`, `GET/PATCH/DELETE /ai/items/{id}`, `POST /ai/{chapters,lessons,items}/{id}/move` |
| Media | `GET/POST /ai/media/videos`, `POST /ai/media/videos/url`, `POST /ai/media/videos/{id}/transcribe`, `GET /ai/media/videos/{id}/file` (Range), `GET /ai/documents/{id}/file`, `GET /ai/documents/{id}/slides` |
| Quan sát | `GET /ai/admin/llm-stats`, `GET /ai/admin/llm-calls`, `GET /health` |

Lỗi trả về thống nhất: `{"request_id", "error": {"code", "message", "details"}, "detail"}`; mọi response có header `X-Request-ID`.

## Lưu ý

- **Bộ đánh giá demo** chỉ có 24 câu gắn với dữ liệu demo. Trước khi lấy số liệu cho báo cáo, soạn 50–100 câu từ học liệu thật
  (định dạng như `sample_data/eval_samples.json`, trường `relevant_sources` là nguồn đúng) và nạp ở tab Đánh giá.
- `RAG_MIN_SCORE` (mặc định 0.30) là ngưỡng để Tutor từ chối khi học liệu không đủ liên quan; nên hiệu chỉnh bằng tập dev.
- Phiên âm video dùng ffmpeg đi kèm gói `imageio-ffmpeg` để tách audio và cắt đoạn 10 phút (giới hạn 25 MB của Whisper API).
