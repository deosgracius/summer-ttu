"""Generate a PDF booking receipt with ReportLab."""
import io
import datetime
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas


def build_pdf(r):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    w, h = A4
    y = h - 28 * mm
    c.setFillColorRGB(0.13, 0.83, 0.93)
    c.setFont("Helvetica-Bold", 22); c.drawString(20 * mm, y, "SUMMER")
    c.setFillColorRGB(0, 0, 0)
    c.setFont("Helvetica", 11); c.drawRightString(w - 20 * mm, y, "Booking receipt"); y -= 14 * mm
    c.setFont("Helvetica", 11)
    for label, val in [("Event", r.get("event", "")), ("When", r.get("when") or "-"),
                       ("Location", r.get("location") or "-"), ("Speaker", r.get("speaker") or "-"),
                       ("Customer", r.get("customer", "")), ("Booking #", str(r.get("booking_id", "")))]:
        c.drawString(20 * mm, y, f"{label}:"); c.drawString(55 * mm, y, str(val)); y -= 7 * mm
    y -= 4 * mm
    c.setFont("Helvetica-Bold", 12); c.drawString(20 * mm, y, "Seats"); y -= 8 * mm
    c.setFont("Helvetica", 11)
    for it in r.get("items", []):
        c.drawString(24 * mm, y, f"{it['quantity']} x {it['category']}  @ ${it['price']:.2f}")
        c.drawRightString(w - 20 * mm, y, f"${it['line_total']:.2f}"); y -= 7 * mm
    y -= 3 * mm; c.line(20 * mm, y, w - 20 * mm, y); y -= 9 * mm
    c.setFont("Helvetica-Bold", 13)
    c.drawString(20 * mm, y, "Total paid"); c.drawRightString(w - 20 * mm, y, f"${r.get('total', 0):.2f}")
    y -= 16 * mm
    c.setFont("Helvetica-Oblique", 9)
    c.drawString(20 * mm, y, f"Issued {datetime.datetime.now().strftime('%Y-%m-%d %H:%M')} - Summer Events - test mode")
    c.showPage(); c.save(); buf.seek(0)
    return buf.getvalue()
