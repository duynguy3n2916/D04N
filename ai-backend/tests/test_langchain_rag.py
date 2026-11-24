"""Các thành phần LangChain của RAG: text splitter, Embeddings, retriever trả về Document, chat model."""
from langchain_core.documents import Document
from langchain_core.embeddings import Embeddings
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage
from langchain_core.retrievers import BaseRetriever

from app.services.ai import llm
from app.services.rag.chunking import split_documents
from app.services.rag.embedding import embed_query, embed_texts, get_embeddings
from app.services.rag.retrieval import RetrievalScope, get_retriever, retrieve
from tests.test_api_core import upload

DOC = ("# Mẫu Factory\n\nFactory Method để lớp con quyết định lớp cụ thể nào được tạo ra. "
       "Client chỉ làm việc với giao diện sản phẩm.\n\n"
       "# Mẫu Adapter\n\nAdapter chuyển giao diện của một lớp thành giao diện khác mà client mong đợi.\n")


def test_split_documents_keeps_source_metadata():
    docs = split_documents([{"text": "Câu một. " * 80, "section": "Mở đầu", "page": 3}], chunk_size=200, overlap=40)
    assert len(docs) > 2 and all(isinstance(d, Document) and len(d.page_content) <= 200 for d in docs)
    assert all(d.metadata == {"section": "Mở đầu", "page": 3} for d in docs)
    assert split_documents([{"text": "   "}]) == []


def test_embeddings_are_langchain_and_consistent():
    emb = get_embeddings()
    assert isinstance(emb, Embeddings) and get_embeddings() is emb
    assert embed_texts(["đóng gói"])[0] == embed_query("đóng gói") and len(embed_query("x")) == 384


def test_retriever_returns_documents(client, teacher):
    upload(client, teacher, "factory.md", DOC, lesson_id="lesson-lc", class_id="lop-a")
    from app.database import SessionLocal
    db = SessionLocal()
    try:
        scope = RetrievalScope(allowed_class_ids=None, lesson_id="lesson-lc")
        retriever = get_retriever(db, scope, top_k=2, min_score=0.0)
        assert isinstance(retriever, BaseRetriever)
        docs = retriever.invoke("mẫu factory method lớp con")
        assert docs and isinstance(docs[0], Document) and "Factory" in docs[0].page_content
        assert docs[0].metadata["document_title"] == "factory.md" and docs[0].id == docs[0].metadata["chunk_id"]
        # API cũ vẫn trả về dict giống metadata + content
        old = retrieve(db, "mẫu factory method lớp con", scope, top_k=2, min_score=0.0)
        assert old[0]["content"] == docs[0].page_content and old[0]["chunk_id"] == docs[0].metadata["chunk_id"]
        # phạm vi quyền vẫn áp dụng: học sinh lớp khác không thấy tài liệu của lop-a
        assert get_retriever(db, RetrievalScope(allowed_class_ids=["lop-z"], lesson_id="lesson-lc"),
                             min_score=0.0).invoke("factory") == []
    finally:
        db.close()


def test_chat_model_gateway_uses_langchain(monkeypatch):
    usage = {"input_tokens": 11, "output_tokens": 4, "total_tokens": 15}
    made = []

    def fake_chat_model(**kw):
        made.append(kw)
        return GenericFakeChatModel(messages=iter([AIMessage(content="Đóng gói là che giấu dữ liệu.", usage_metadata=usage,
                                                             response_metadata={"model_name": "fake-lc"})]))

    monkeypatch.setattr(llm, "chat_model", fake_chat_model)
    text, in_tok, out_tok, model = llm._call_provider("sys", [{"role": "user", "content": "hỏi"}], 100, True, 0.2)
    assert (text, in_tok, out_tok, model) == ("Đóng gói là che giấu dữ liệu.", 11, 4, "fake-lc")
    assert made[-1]["json_mode"] is True and made[-1]["max_tokens"] == 100

    pieces = list(llm._stream_provider("sys", [{"role": "user", "content": "hỏi"}], 100, 0.2))
    assert "".join(p for p in pieces if isinstance(p, str)) == "Đóng gói là che giấu dữ liệu."
    assert isinstance(pieces[-1], tuple) and made[-1]["streaming"] is True  # (input_tokens, output_tokens, model)


def test_to_lc_messages_roles():
    msgs = llm.to_lc_messages("hệ thống", [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}])
    assert [m.type for m in msgs] == ["system", "human", "ai"]
