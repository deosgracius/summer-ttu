# --- Stage 1: build the React campus UI ---
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build          # outputs /web/dist

# --- Stage 2: FastAPI backend that also serves the built UI ---
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 WEB_DIST=/app/webdist
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY import_ttu_ece.py ./
COPY import_cross_listed.py ./
COPY --from=web /web/dist ./webdist
EXPOSE 8000
# Bind the host-provided $PORT when present (Render/Zeabur/Koyeb set it), else 8000
# (Fly's fly.toml internal_port). Shell form so ${PORT} expands at runtime.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
