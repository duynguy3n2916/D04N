"""Embedding qua giao diện LangChain `Embeddings`: local (HuggingFace / sentence-transformers) | openai | hash.

`get_embeddings()` trả về đối tượng LangChain dùng chung (cache theo cấu hình); các hàm embed_* giữ API cũ
cho ingestion, transcription và test.
"""
import hashlib
import math
import re
import threading

from langchain_core.embeddings import Embeddings

from app.config import settings

_cache: dict[tuple, Embeddings] = {}
_lock = threading.Lock()


class HashEmbeddings(Embeddings):
    """Bag-of-words băm (không ngữ nghĩa) — chỉ dùng cho test tự động khi không có model."""

    def __init__(self, dim: int):
        self.dim = dim

    def _embed(self, text: str) -> list[float]:
        vec = [0.0] * self.dim
        for tok in re.findall(r"\w+", text.lower()):
            h = int(hashlib.md5(tok.encode()).hexdigest(), 16)
            vec[h % self.dim] += 1.0 if (h >> 8) % 2 else -1.0
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [v / norm for v in vec]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self._embed(t) for t in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._embed(text)


def _build(provider: str) -> Embeddings:
    if provider == "local":
        from langchain_huggingface import HuggingFaceEmbeddings
        return HuggingFaceEmbeddings(model_name=settings.embedding_model,
                                     encode_kwargs={"normalize_embeddings": True, "batch_size": 32})
    if provider == "openai":
        from langchain_openai import OpenAIEmbeddings
        return OpenAIEmbeddings(model=settings.openai_embedding_model, api_key=settings.openai_api_key,
                                timeout=60, max_retries=2)
    if provider == "hash":
        return HashEmbeddings(settings.embedding_dim)
    raise ValueError(f"EMBEDDING_PROVIDER không hỗ trợ: {settings.embedding_provider}")


def get_embeddings() -> Embeddings:
    provider = settings.embedding_provider.lower()
    key = (provider, settings.embedding_model, settings.openai_embedding_model, settings.embedding_dim)
    emb = _cache.get(key)
    if emb is None:
        with _lock:
            emb = _cache.get(key)
            if emb is None:
                emb = _cache[key] = _build(provider)
    return emb


def embed_texts(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    return [list(map(float, v)) for v in get_embeddings().embed_documents(list(texts))]


def embed_batched(texts: list[str], batch_size: int = 64) -> list[list[float]]:
    out: list[list[float]] = []
    for i in range(0, len(texts), batch_size):
        out.extend(embed_texts(texts[i: i + batch_size]))
    return out


def embed_query(text: str) -> list[float]:
    return list(map(float, get_embeddings().embed_query(text)))


def warmup() -> None:
    if settings.embedding_provider.lower() == "local":
        get_embeddings()
