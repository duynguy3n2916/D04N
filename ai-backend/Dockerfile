# Build từ thư mục gốc repo:  docker build -f ai-backend/Dockerfile .
# Image gồm cả backend (FastAPI) và giao diện đã build (phục vụ tại /app/).

# ---------- Stage 1: build giao diện ----------
FROM node:22-alpine AS frontend
WORKDIR /src
COPY frontend/package*.json ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------- Stage 2: backend ----------
FROM python:3.10-slim AS runtime
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    FRONTEND_DIST=/app/frontend/dist \
    STORAGE_PATH=/data/storage \
    HF_HOME=/data/hf-cache
WORKDIR /app

# Torch bản CPU (embedding chạy local không cần GPU) để image nhỏ hơn nhiều.
# Phải nâng pip trước: pip 23 đi kèm python:3.10-slim lấy typing_extensions dạng sdist từ index PyTorch
# rồi đòi build (cần flit_core, index đó không có) -> build image linux/arm64 thất bại.
RUN pip install --upgrade pip \
    && pip install --only-binary=:all: --index-url https://download.pytorch.org/whl/cpu torch

COPY ai-backend/requirements.txt ./
RUN pip install -r requirements.txt

COPY ai-backend/ ./
COPY --from=frontend /src/dist ./frontend/dist

RUN useradd --create-home app \
    && mkdir -p /data/storage /data/hf-cache \
    && chown -R app:app /data /app
USER app

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=5)"

CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
