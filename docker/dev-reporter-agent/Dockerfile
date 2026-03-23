FROM php:8.5-apache

RUN apt-get update && apt-get install -y \
        libpq-dev \
        libicu-dev \
        libzip-dev \
        unzip \
    && docker-php-ext-install pdo_pgsql zip \
    && docker-php-ext-configure intl \
    && docker-php-ext-install intl \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

COPY brama-core/apps/dev-reporter-agent/ /var/www/html/
COPY docker/dev-reporter-agent/entrypoint.sh /usr/local/bin/dev-reporter-agent-entrypoint

RUN a2enmod rewrite \
    && sed -ri \
        -e 's!/var/www/html!/var/www/html/public!g' \
        /etc/apache2/sites-available/000-default.conf \
        /etc/apache2/apache2.conf \
    && sed -ri \
        -e 's/AllowOverride None/AllowOverride All/g' \
        /etc/apache2/apache2.conf \
    && chmod +x /usr/local/bin/dev-reporter-agent-entrypoint

WORKDIR /var/www/html

ENTRYPOINT ["/usr/local/bin/dev-reporter-agent-entrypoint"]
CMD ["apache2-foreground"]
