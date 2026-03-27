# Dockerfile Ownership

## Огляд / Overview

Application Dockerfiles belong in the root of the application or agent project that they build.

For Brama workspace layout, that means:

- place agent Dockerfiles in the agent project root, for example `brama-agents/my-agent/Dockerfile`
- keep workspace Compose files in the workspace root
- keep `docker/` for shared runtime assets and helper images, not for application-owned Dockerfiles

This keeps build context, source ownership, and deployment changes in one place.

## Швидкий старт / Quick Start

1. Copy the template Dockerfile into the agent project root.
2. Point Compose `build.context` at that project directory.
3. Keep `dockerfile: Dockerfile` relative to the project root.

Example:

```yaml
services:
  my-agent:
    build:
      context: ../brama-agents/my-agent
      dockerfile: Dockerfile
```

## Конфігурація / Configuration

- `build.context` should target the application directory that contains the source code and Dockerfile.
- `dockerfile` should usually stay as `Dockerfile` when the file lives in the project root.
- Shared workspace assets such as reverse proxies, utility images, or reusable scripts can still live under `docker/`.
- For Alpine PHP images that install the `sockets` extension, include `linux-headers` in build dependencies before running `docker-php-ext-install sockets`.

## Приклади / Examples

Recommended layout:

```text
brama-workspace/
  compose.agents.yaml
  brama-agents/
    knowledge-agent/
      Dockerfile
      src/
```

Avoid this layout for application-owned images:

```text
brama-workspace/
  docker/
    knowledge-agent/
      Dockerfile
```

The current `knowledge-agent` image follows the project-root ownership rule and keeps Alpine PHP build dependencies next to the application code.
