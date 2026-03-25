# Stage 1: Install Python dependencies
FROM python:3.12-alpine AS deps

WORKDIR /app

RUN apk add --no-cache --virtual .build-deps gcc musl-dev postgresql-dev
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt
RUN apk del .build-deps

# Stage 2: Runtime (Alpine)
FROM python:3.12-alpine

RUN apk add --no-cache libpq curl

WORKDIR /app

COPY --from=deps /install /usr/local
COPY . .
COPY docker/entrypoint.sh /usr/local/bin/news-maker-agent-entrypoint
RUN chmod +x /usr/local/bin/news-maker-agent-entrypoint

EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/news-maker-agent-entrypoint"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
