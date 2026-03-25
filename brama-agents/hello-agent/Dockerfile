# Stage 1: Composer dependencies
FROM composer:2 AS vendor
WORKDIR /app
COPY composer.json composer.lock ./
RUN composer install --no-dev --optimize-autoloader --no-interaction --no-scripts --prefer-dist --ignore-platform-reqs
COPY . .
RUN composer dump-autoload --optimize --no-dev

# Stage 2: Runtime (Alpine + PHP-FPM + Caddy)
FROM php:8.5-fpm-alpine

RUN apk add --no-cache caddy icu-libs libzip \
    && apk add --no-cache --virtual .build-deps $PHPIZE_DEPS icu-dev libzip-dev \
    && docker-php-ext-install zip \
    && docker-php-ext-configure intl && docker-php-ext-install intl \
    && apk del .build-deps && rm -rf /tmp/pear

RUN echo ':80 {' > /etc/caddy/Caddyfile \
    && echo '    root * /var/www/html/public' >> /etc/caddy/Caddyfile \
    && echo '    php_fastcgi 127.0.0.1:9000' >> /etc/caddy/Caddyfile \
    && echo '    file_server' >> /etc/caddy/Caddyfile \
    && echo '}' >> /etc/caddy/Caddyfile

WORKDIR /var/www/html
COPY --from=vendor /app /var/www/html/
RUN mkdir -p var/cache var/log && chmod -R 777 var/

RUN printf '#!/bin/sh\nphp-fpm -D\nexec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile\n' > /usr/local/bin/start.sh \
    && chmod +x /usr/local/bin/start.sh

EXPOSE 80
CMD ["/usr/local/bin/start.sh"]
