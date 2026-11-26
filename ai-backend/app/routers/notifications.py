"""API thông báo: số mục mới trên thanh điều hướng và hộp thư thông báo."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.security import Principal, get_current_user
from app.core.utils import parse_uuid
from app.database import get_db

router = APIRouter(prefix="/ai", tags=["notifications"])


@router.get("/notifications/summary")
def notifications_summary(user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    """Số nội dung mới chưa đọc trong diễn đàn các lớp và số thẻ flashcard đến hạn."""
    from app.services.social import notifications
    return notifications.summary(db, user)


class SeenIn(BaseModel):
    key: str = Field(min_length=1, max_length=160)  # vd "forum:<class_id>"


@router.get("/notifications/inbox")
def notifications_inbox(user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    from app.services.social import notifications
    return notifications.inbox(db, user)


class InboxReadIn(BaseModel):
    notification_id: str | None = None  # bỏ trống = đánh dấu tất cả đã đọc


@router.post("/notifications/inbox/read")
def notifications_inbox_read(req: InboxReadIn, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    from app.services.social import notifications
    return notifications.mark_inbox_read(db, user, parse_uuid(req.notification_id, "notification_id", required=False))


@router.post("/notifications/seen")
def notifications_seen(req: SeenIn, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    from app.services.social import notifications
    return notifications.mark_seen(db, user, req.key)
