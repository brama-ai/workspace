# Dockerfile Ownership

## Огляд / Overview

Dockerfile застосунку має жити в корені того застосунку або агент-проєкту, який він збирає.

Для структури Brama workspace це означає:

- розміщуйте Dockerfile агента в корені агент-проєкту, наприклад `brama-agents/my-agent/Dockerfile`
- зберігайте workspace Compose-файли в корені workspace
- використовуйте `docker/` для спільних runtime-асетів і допоміжних образів, а не для Dockerfile, якими володіє застосунок

Так build context, ownership коду та зміни деплою залишаються в одному місці.

## Швидкий старт / Quick Start

1. Скопіюйте шаблонний Dockerfile в корінь агент-проєкту.
2. Спрямуйте Compose `build.context` на директорію цього проєкту.
3. Залишайте `dockerfile: Dockerfile` відносно кореня проєкту.

Приклад:

```yaml
services:
  my-agent:
    build:
      context: ../brama-agents/my-agent
      dockerfile: Dockerfile
```

## Конфігурація / Configuration

- `build.context` має вказувати на директорію застосунку, де лежать вихідний код і Dockerfile.
- `dockerfile` зазвичай має залишатися `Dockerfile`, якщо файл лежить у корені проєкту.
- Спільні workspace-асети, як-от reverse proxy, utility image або повторно використовувані скрипти, і надалі можуть жити в `docker/`.
- Для Alpine PHP image, які встановлюють розширення `sockets`, додайте `linux-headers` у build-залежності перед `docker-php-ext-install sockets`.

## Приклади / Examples

Рекомендована структура:

```text
brama-workspace/
  compose.agents.yaml
  brama-agents/
    knowledge-agent/
      Dockerfile
      src/
```

Уникайте такої структури для образів, якими володіє застосунок:

```text
brama-workspace/
  docker/
    knowledge-agent/
      Dockerfile
```

Поточний образ `knowledge-agent` уже дотримується правила project-root ownership і тримає Alpine PHP build-залежності поруч із кодом застосунку.
