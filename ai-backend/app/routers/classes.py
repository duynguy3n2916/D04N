from fastapi import APIRouter, Depends, Path
from sqlalchemy.orm import Session
from typing import List, Optional, Dict, Any
from pydantic import BaseModel
from datetime import datetime

# Đảm bảo import đúng đường dẫn của project
from app.database import get_db
from app.models.learning import CourseClass, Course, Chapter, Lesson, LessonItem, ItemProgress, UserProfile

router = APIRouter()

class SubmissionRow(BaseModel):
    student_id: str
    student_name: str
    item_id: str
    quiz_title: str
    lesson_code: str
    course_title: str
    status: str
    passed: Optional[bool] = None
    correct: Optional[int] = None
    total: Optional[int] = None
    score: Optional[float] = None
    time_up: bool = False
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None

class SubmissionsResponse(BaseModel):
    class_id: str
    quizzes: int
    students: int
    rows: List[SubmissionRow]
    debug_info: Optional[Dict[str, Any]] = None  # <--- THÊM MÁY QUÉT VÀO ĐÂY

@router.get("/ai/classes/{class_id}/submissions", response_model=SubmissionsResponse)
def get_class_submissions(
    class_id: str = Path(..., description="Mã lớp học"),
    db: Session = Depends(get_db)
):
    # 1. LẤY HỌC VIÊN
    students_query = db.query(UserProfile).filter(
        UserProfile.class_ids.op('?')(class_id),
        UserProfile.role == "student"
    ).all()
    
    student_dict = {s.user_id: s.display_name or s.user_id for s in students_query}
    student_ids = list(student_dict.keys())
    
    # 2. TẢI TẤT CẢ DỮ LIỆU ĐỂ DEBUG
    all_courses = db.query(Course).all()
    all_chapters = db.query(Chapter).all()
    all_lessons = db.query(Lesson).all()
    all_items = db.query(LessonItem).all()
    all_progress = db.query(ItemProgress).all()
    all_links = db.query(CourseClass).all()

    # KHỞI TẠO BỘ ĐẾM DEBUG
    debug = {
        "1_db_courses_count": len(all_courses),
        "2_db_chapters_count": len(all_chapters),
        "3_db_lessons_count": len(all_lessons),
        "4_db_items_count": len(all_items),
        "5_quiz_type_count": sum(1 for i in all_items if str(i.type).strip().lower() == "quiz"),
        "error_dropped_no_lesson": 0,
        "error_dropped_no_chapter": 0,
        "error_dropped_no_course": 0,
        "error_dropped_invalid_class": 0,
        "success_valid_quizzes_found": 0
    }

    if not student_ids:
        return SubmissionsResponse(class_id=class_id, quizzes=0, students=0, rows=[], debug_info=debug)

    progress_dict = {}
    item_ids_done = set()
    for p in all_progress:
        if p.student_id in student_ids:
            item_id_str = str(p.item_id)
            progress_dict[(p.student_id, item_id_str)] = p
            item_ids_done.add(item_id_str)

    course_map = {str(c.id): c for c in all_courses}
    chapter_map = {str(ch.id): ch for ch in all_chapters}
    lesson_map = {str(l.id): l for l in all_lessons}
    
    link_map = {}
    for link in all_links:
        link_map.setdefault(str(link.course_id), []).append(link.class_id)
        
    quiz_dict = {}
    for item in all_items:
        if str(item.type).strip().lower() != "quiz":
            continue
            
        qid_str = str(item.id)
        lesson = lesson_map.get(str(item.lesson_id))
        if not lesson:
            debug["error_dropped_no_lesson"] += 1
            continue
            
        chapter = chapter_map.get(str(lesson.chapter_id))
        if not chapter:
            debug["error_dropped_no_chapter"] += 1
            continue
            
        course = course_map.get(str(chapter.course_id))
        if not course:
            debug["error_dropped_no_course"] += 1
            continue
            
        cid_str = str(course.id)
        is_valid = False
        
        c_class_id = course.class_id
        if not c_class_id or str(c_class_id).strip().lower() in ["", "null", "none"]:
            is_valid = True
        elif c_class_id == class_id:
            is_valid = True
        elif cid_str in link_map and class_id in link_map[cid_str]:
            is_valid = True
        elif qid_str in item_ids_done:
            is_valid = True
            
        if is_valid:
            quiz_dict[qid_str] = {
                "quiz": item,
                "lesson_code": lesson.code,
                "course_title": course.title
            }
        else:
            debug["error_dropped_invalid_class"] += 1

    debug["success_valid_quizzes_found"] = len(quiz_dict)

    if not quiz_dict:
        return SubmissionsResponse(class_id=class_id, quizzes=0, students=len(student_ids), rows=[], debug_info=debug)

    rows = []
    for sid in student_ids:
        for qid_str, info in quiz_dict.items():
            quiz = info["quiz"]
            prog = progress_dict.get((sid, qid_str))
            
            item_meta = quiz.meta or {}
            prog_meta = prog.meta if prog else {}
            
            total = item_meta.get("count") 
            correct = None
            if prog_meta and "answers" in prog_meta:
                answers = prog_meta.get("answers", {})
                correct = sum(1 for v in answers.values() if v is True)
                if total is None:
                    total = len(answers)
            
            score = prog.score if prog else None
            status = "not_started"
            passed = None
            
            if prog:
                if prog.status == "completed":
                    pass_ratio = item_meta.get("pass_ratio", 0.5)
                    passed = (score is not None and score >= pass_ratio)
                    status = "passed" if passed else "failed"
                else:
                    status = "in_progress"

            time_up = prog_meta.get("time_up", False) if prog_meta else False
            finished_at = prog.completed_at if prog else None
            started_at = prog.updated_at if prog else None
            
            rows.append(SubmissionRow(
                student_id=sid,
                student_name=student_dict[sid],
                item_id=qid_str,
                quiz_title=quiz.title,
                lesson_code=info["lesson_code"],
                course_title=info["course_title"],
                status=status,
                passed=passed,
                correct=correct,
                total=total,
                score=score,
                time_up=time_up,
                started_at=started_at,
                finished_at=finished_at
            ))

    return SubmissionsResponse(
        class_id=class_id,
        quizzes=len(quiz_dict),
        students=len(student_ids),
        rows=rows,
        debug_info=debug
    )