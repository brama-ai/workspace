FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev gcc curl \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY agents/news-maker-agent/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY agents/news-maker-agent/ .
COPY docker/news-maker-agent/entrypoint.sh /usr/local/bin/news-maker-agent-entrypoint

RUN chmod +x /usr/local/bin/news-maker-agent-entrypoint

EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/news-maker-agent-entrypoint"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
