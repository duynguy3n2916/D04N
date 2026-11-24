"""Làm sạch và chia đoạn văn bản cho RAG bằng LangChain `RecursiveCharacterTextSplitter`.

Thứ tự ranh giới ưu tiên: đoạn văn -> dòng -> câu -> từ -> ký tự, nên chunk luôn <= chunk_size và
overlap giữa hai chunk liền nhau rơi vào ranh giới câu / từ khi có thể.
"""
import re

from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter

# Ranh giới câu (giữ dấu câu ở cuối câu trước). Các phần tử đều là regex (is_separator_regex=True).
SEPARATORS = [r"\n\n", r"\n", r"(?<=[\.\!\?…;:])\s+", r" ", r""]


def clean_text(text: str) -> str:
    text = text.replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t ]+", " ", text)
    text = re.sub(r"-\n(?=\w)", "", text)  # nối từ bị ngắt dòng trong PDF
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def get_splitter(chunk_size: int = 800, overlap: int = 100) -> RecursiveCharacterTextSplitter:
    return RecursiveCharacterTextSplitter(
        chunk_size=chunk_size, chunk_overlap=min(overlap, max(0, chunk_size - 1)),
        separators=SEPARATORS, is_separator_regex=True, keep_separator="end", strip_whitespace=True,
    )


def split_documents(sections: list[dict], chunk_size: int = 800, overlap: int = 100) -> list[Document]:
    """sections: [{"text", "section"?, "page"?}] (đầu ra của parsers) -> LangChain Document kèm metadata nguồn."""
    splitter = get_splitter(chunk_size, overlap)
    docs: list[Document] = []
    for item in sections:
        text = clean_text(item.get("text") or "")
        if not text:
            continue
        meta = {"section": item.get("section"), "page": item.get("page")}
        docs.extend(d for d in splitter.create_documents([text], metadatas=[meta]) if d.page_content.strip())
    return docs


def chunk_text(text: str, chunk_size: int = 800, overlap: int = 100, section: str | None = None) -> list[dict]:
    """Giữ API cũ: trả về [{"content", "section"}]."""
    docs = split_documents([{"text": text, "section": section}], chunk_size, overlap)
    return [{"content": d.page_content, "section": d.metadata.get("section")} for d in docs]
