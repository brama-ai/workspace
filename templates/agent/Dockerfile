# =============================================================================
# templates/agent/Dockerfile
# =============================================================================
# Minimal reference Dockerfile for a platform agent.
#
# Ownership rule: this file belongs at the ROOT of the agent project directory
# (e.g., brama-agents/my-agent/Dockerfile), NOT inside the workspace docker/
# directory. The workspace Compose file references it via:
#
#   build:
#     context: ../brama-agents/my-agent
#     dockerfile: Dockerfile
#
# See docs/guides/deployment/en/dockerfile-ownership.md for the full rule.
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
