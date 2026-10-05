"""Embedding provider: local (sentence-transformers) | openai | hash (chỉ cho kiểm thử)."""
import hashlib
import math
import re
import threading

from app.config import settings

_local_model = None
_lock = threading.Lock()


def _get_local_model():
    global _local_model
    if _local_model is None:
        with _lock:
            if _local_model is None:
                from sentence_transformers import SentenceTransformer
                _local_model = SentenceTransformer(settings.embedding_model)
    return _local_model


def _hash_embed(text: str, dim: int) -> list[float]:
    """Bag-of-words băm (không ngữ nghĩa) — chỉ dùng cho test tự động khi không có model."""
    vec = [0.0] * dim
    for tok in re.findall(r"\w+", text.lower()):
        h = int(hashlib.md5(tok.encode()).hexdigest(), 16)
        vec[h % dim] += 1.0 if (h >> 8) % 2 else -1.0
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


def embed_texts(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    provider = settings.embedding_provider.lower()
    if provider == "local":
        model = _get_local_model()
        embs = model.encode(texts, normalize_embeddings=True, batch_size=32)
        return [e.tolist() for e in embs]
    if provider == "openai":
        from openai import OpenAI
        client = OpenAI(api_key=settings.openai_api_key, timeout=60)
        resp = client.embeddings.create(model=settings.openai_embedding_model, input=texts)
        return [d.embedding for d in resp.data]
    if provider == "hash":
        return [_hash_embed(t, settings.embedding_dim) for t in texts]
    raise ValueError(f"EMBEDDING_PROVIDER không hỗ trợ: {settings.embedding_provider}")


def embed_batched(texts: list[str], batch_size: int = 64) -> list[list[float]]:
    out: list[list[float]] = []
    for i in range(0, len(texts), batch_size):
        out.extend(embed_texts(texts[i: i + batch_size]))
    return out


def embed_query(text: str) -> list[float]:
    return embed_texts([text])[0]


def warmup() -> None:
    if settings.embedding_provider.lower() == "local":
        _get_local_model()
