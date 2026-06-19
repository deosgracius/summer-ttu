"""Email a PDF receipt. Prefers SMTP; caller can fall back to Gmail API."""
import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.application import MIMEApplication


def smtp_configured():
    return all(os.getenv(k) for k in ("SMTP_HOST", "SMTP_USER", "SMTP_PASS"))


def send_with_pdf(to_list, subject, body, pdf_bytes, filename="receipt.pdf"):
    to_list = [t for t in to_list if t]
    if not smtp_configured() or not to_list:
        return False
    host = os.getenv("SMTP_HOST"); user = os.getenv("SMTP_USER"); pwd = os.getenv("SMTP_PASS")
    port = int(os.getenv("SMTP_PORT", "587")); frm = os.getenv("SMTP_FROM", user)
    msg = MIMEMultipart()
    msg["From"] = frm; msg["To"] = ", ".join(to_list); msg["Subject"] = subject
    msg.attach(MIMEText(body, "plain"))
    part = MIMEApplication(pdf_bytes, _subtype="pdf")
    part.add_header("Content-Disposition", "attachment", filename=filename)
    msg.attach(part)
    try:
        with smtplib.SMTP(host, port, timeout=15) as s:
            s.starttls(); s.login(user, pwd); s.sendmail(frm, to_list, msg.as_string())
        return True
    except Exception:
        return False


def send_text(to_list, subject, body):
    to_list = [t for t in to_list if t]
    if not smtp_configured() or not to_list:
        return False
    host = os.getenv("SMTP_HOST"); user = os.getenv("SMTP_USER"); pwd = os.getenv("SMTP_PASS")
    port = int(os.getenv("SMTP_PORT", "587")); frm = os.getenv("SMTP_FROM", user)
    msg = MIMEText(body); msg["From"] = frm; msg["To"] = ", ".join(to_list); msg["Subject"] = subject
    try:
        with smtplib.SMTP(host, port, timeout=15) as s:
            s.starttls(); s.login(user, pwd); s.sendmail(frm, to_list, msg.as_string())
        return True
    except Exception:
        return False
