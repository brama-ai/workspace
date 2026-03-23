# =============================================================================
# templates/agent/Dockerfile
# =============================================================================
# Minimal reference Dockerfile for a platform agent.
# Copy to your agent project and adjust as needed.
# =============================================================================

FROM php:8.3-fpm-alpine

WORKDIR /app

# Install system deps (adjust per agent needs)
# RUN apk add --no-cache curl

COPY . .

# Install application deps
# RUN composer install --no-dev --optimize-autoloader

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=30s \
  CMD curl -sf http://localhost/health || exit 1

# CMD ["php-fpm"]
