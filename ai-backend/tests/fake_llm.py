"""LLM giả lập cho test và chạy thử giao diện không cần API key."""
import json
import re
import time


class FakeLLM:
    """Trả lời theo loại prompt. Có thể đặt override cho từng loại trong test."""

    def __init__(self):
        self.calls: list[dict] = []
        self.overrides: dict[str, list] = {}
        self.delay = 0.0

    def push(self, kind: str, *responses):
        self.overrides.setdefault(kind, []).extend(responses)

    @staticmethod
    def kind_of(system: str) -> str:
        table = [("Tutor AI giải thích đáp án", "explain"), ("Question Agent", "agent"), ("học tập qua video", "video_question"),
                 ("soạn câu hỏi", "teacher"), ("chuyên gia sư phạm", "suggest"), ("chấm câu trả lời", "grader"),
                 ("giám khảo", "judge"), ("ĐANG làm một câu hỏi", "hint"), ("Tóm tắt ngắn gọn", "summary"),
                 ("Tutor AI hỗ trợ học sinh", "tutor")]
        for key, kind in table:
            if key in system:
                return kind
        return "unknown"

    def __call__(self, system, messages, max_tokens, json_mode, temperature):
        if self.delay:
            time.sleep(self.delay)
        kind = self.kind_of(system)
        user = messages[-1]["content"]
        self.calls.append({"kind": kind, "user": user, "messages": messages})
        if self.overrides.get(kind):
            r = self.overrides[kind].pop(0)
            if isinstance(r, Exception):
                raise r
            return (r if isinstance(r, str) else json.dumps(r, ensure_ascii=False)), 100, 50, "fake-model"
        return self.default(kind, user), 100, 50, "fake-model"

    @staticmethod
    def mcq(q="Câu hỏi kiểm tra về đóng gói?", ans="B"):
        return {"type": "multiple_choice", "difficulty": "medium", "question": q,
                "options": ["A. Lựa chọn một", "B. Gom dữ liệu và phương thức, che giấu chi tiết",
                            "C. Lựa chọn ba", "D. Lựa chọn bốn"], "correct_answer": ans,
                "explanation": "Vì đó là định nghĩa đóng gói.", "sources": ["S1"]}

    def default(self, kind, user):
        if kind in ("agent", "video_question"):
            n = len(self.calls)
            return json.dumps(self.mcq(f"Câu hỏi số {n} về nội dung vừa học?"), ensure_ascii=False)
        if kind == "teacher":
            m = re.search(r"sinh (\d+) câu", user)
            n = int(m.group(1)) if m else 1
            return json.dumps({"questions": [self.mcq(f"Câu hỏi giáo viên {i + 1}?") for i in range(n)]},
                              ensure_ascii=False)
        if kind == "suggest":
            m = re.search(r"tức (\d+)s–(\d+)s", user)
            a, b = (float(m.group(1)), float(m.group(2))) if m else (0.0, 60.0)
            return json.dumps({"suggestions": [{"timestamp": (a + b) / 2, "concept": "Khái niệm", "importance_score": 7,
                                                "reason": "quan trọng", "sample_question": self.mcq()}]},
                              ensure_ascii=False)
        if kind == "grader":
            return json.dumps({"verdict": "partial", "feedback": "Đúng một phần."}, ensure_ascii=False)
        if kind == "judge":
            return json.dumps({"groundedness": 0.9, "correctness": 0.8, "context_relevance": 0.7, "reason": "ok"})
        if kind == "hint":
            return "Gợi ý: hãy nhớ lại định nghĩa vừa học [S1]."
        if kind == "explain":
            return "Đáp án đúng vì đóng gói là gom dữ liệu và phương thức vào lớp [S1]. Ý chính: lớp là bản thiết kế."
        if kind == "summary":
            return "Học sinh hỏi về OOP."
        return "Đóng gói là gom dữ liệu và phương thức vào lớp [S1]."
