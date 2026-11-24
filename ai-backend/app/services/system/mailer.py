"""Gửi email qua SMTP (thư viện chuẩn). Bật khi đặt SMTP_HOST và SMTP_FROM trong .env."""
import logging
import smtplib
import ssl
import threading
from email.message import EmailMessage

from app.config import settings

log = logging.getLogger("app.mailer")


def enabled() -> bool:
    return bool(settings.smtp_host and settings.smtp_from)


def send(to: str, subject: str, text: str, html: str | None = None) -> None:
    """Gửi đồng bộ; ném lỗi nếu SMTP lỗi. Test có thể thay hàm này."""
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = settings.smtp_from, to, subject
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")
    ctx = ssl.create_default_context()
    if settings.smtp_ssl:
        server = smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, context=ctx, timeout=20)
    else:
        server = smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=20)
    with server:
        if not settings.smtp_ssl and settings.smtp_starttls:
            server.starttls(context=ctx)
        if settings.smtp_user:
            server.login(settings.smtp_user, settings.smtp_password)
        server.send_message(msg)


def send_async(to: str, subject: str, text: str, html: str | None = None) -> None:
    """Gửi ở luồng nền: request trả về ngay, thời gian phản hồi không để lộ tài khoản có tồn tại hay không."""
    def run():
        try:
            send(to, subject, text, html)
        except Exception:
            log.exception("mail_send_failed")
    threading.Thread(target=run, daemon=True, name="mailer").start()
