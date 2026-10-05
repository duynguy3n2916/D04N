"""Làm sạch và chia đoạn văn bản cho RAG."""
import re

_SENT_SPLIT = re.compile(r"(?<=[\.\!\?…;:])\s+")


def clean_text(text: str) -> str:
    text = text.replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t ]+", " ", text)
    text = re.sub(r"-\n(?=\w)", "", text)  # nối từ bị ngắt dòng trong PDF
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _split_long(paragraph: str, chunk_size: int, overlap: int) -> list[str]:
    """Đoạn quá dài: cắt theo câu, ghép câu tới chunk_size, overlap bằng các câu cuối."""
    sentences = [s.strip() for s in _SENT_SPLIT.split(paragraph) if s.strip()]
    pieces: list[str] = []
    current: list[str] = []
    length = 0
    for sent in sentences:
        if len(sent) > chunk_size:  # câu siêu dài -> cắt cứng
            if current:
                pieces.append(" ".join(current))
                current, length = [], 0
            step = max(1, chunk_size - overlap)
            pieces.extend(sent[i: i + chunk_size] for i in range(0, len(sent), step))
            continue
        if length + len(sent) + 1 > chunk_size and current:
            pieces.append(" ".join(current))
            tail: list[str] = []
            tail_len = 0
            for s in reversed(current):
                if tail_len + len(s) > overlap:
                    break
                tail.insert(0, s)
                tail_len += len(s) + 1
            current, length = tail, tail_len
        current.append(sent)
        length += len(sent) + 1
    if current:
        pieces.append(" ".join(current))
    return pieces


def chunk_text(text: str, chunk_size: int = 800, overlap: int = 100, section: str | None = None) -> list[dict]:
    """Ưu tiên ranh giới đoạn văn; overlap giữa các chunk bằng đoạn/câu cuối của chunk trước."""
    text = clean_text(text)
    if not text:
        return []
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    units: list[str] = []
    for p in paragraphs:
        units.extend(_split_long(p, chunk_size, overlap) if len(p) > chunk_size else [p])

    chunks: list[dict] = []
    current = ""
    for unit in units:
        if not current:
            current = unit
        elif len(current) + len(unit) + 2 <= chunk_size:
            current = f"{current}\n\n{unit}"
        else:
            chunks.append({"content": current, "section": section})
            tail = current[-overlap:] if overlap else ""
            # bắt đầu overlap ở ranh giới từ
            if tail and " " in tail:
                tail = tail[tail.index(" ") + 1:]
            current = f"{tail}\n{unit}" if tail and len(tail) + len(unit) + 1 <= chunk_size else unit
    if current:
        chunks.append({"content": current, "section": section})
    return chunks
