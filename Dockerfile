# حاوية خادم التتبّع (ome-tracker) — Python stdlib + passlib/bcrypt
FROM python:3.11-slim

WORKDIR /app

# الاعتماديات أولاً للاستفادة من cache الطبقات
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# كود الـ tracker فقط (الواجهة web تُخدَم من حاوية nginx منفصلة)
COPY tracker/ ./tracker/

ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/tracker \
    TRACKER_HOST=0.0.0.0 \
    TRACKER_PORT=9999

EXPOSE 9999

CMD ["python", "tracker/tracker_rtmp.py"]
