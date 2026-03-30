# Environment Check — `env-check.json`

Foundry Monitor and the pipeline runner validate the development environment before starting any task. The configuration is **per-project** and lives in `env-check.json` at the project root.

## Why

Running a pipeline against a broken environment wastes time and money (LLM tokens). The env-check gate catches problems **before** the first agent starts:

- Docker not running
- Required services (postgres, redis) stopped or unhealthy
- Missing CLI tools
- HTTP endpoints unreachable

## Where the TUI shows it

The Foundry Monitor header displays a real-time ENV indicator:

```
  Foundry Monitor v2.5.0  14:30:00  ● ENV (8 services)              ← all good
  Foundry Monitor v2.5.0  14:30:00  ✗ ENV postgres: exited  [e] up  ← problems
  Foundry Monitor v2.5.0  14:30:00  ? ENV env-check.json missing    ← no config
```

- `●` green — environment ready
- `✗` red — problems detected (up to 3 reasons shown)
- `?` yellow — `env-check.json` not found

Press `[e]` to run `docker compose up -d` and bring the environment up.

## File location

```
<project-root>/env-check.json
```

Every project that uses Foundry pipelines **must** have this file. If the file is missing, the TUI shows a warning and the pipeline runner refuses to start tasks.

## Schema

```jsonc
{
  // Docker Compose files to use (relative to project root)
  "compose_files": [
    "docker/compose.yaml",
    "docker/compose.core.yaml"
  ],

  // Services that MUST be running. Pipeline fails if any is down.
  "required_services": [
    { "name": "postgres",  "healthcheck": true },
    { "name": "redis",     "healthcheck": true },
    { "name": "rabbitmq",  "healthcheck": true }
  ],

  // Services that are checked but don't block the pipeline
  "optional_services": [
    "traefik",
    "litellm"
  ],

  // HTTP endpoints to probe (curl -sf)
  "healthcheck_urls": [
    { "url": "http://localhost:8080/api", "label": "Traefik", "required": false },
    { "url": "http://localhost:15672",    "label": "RabbitMQ UI", "required": false }
  ],

  // Shell commands to verify tools are available
  "commands": [
    { "cmd": "docker info",   "label": "Docker daemon",  "required": true },
    { "cmd": "git --version", "label": "Git",            "required": true },
    { "cmd": "php -v",        "label": "PHP",            "required": true }
  ],

  // Command to start the environment (used by [e] key in TUI)
  "up_command": "docker compose -f docker/compose.yaml -f docker/compose.core.yaml up -d"
}
```

## Field reference

### `compose_files`

**Required.** Array of Docker Compose file paths relative to the project root. Used to:
- Query service status (`docker compose ps`)
- Build the `up` command (if `up_command` is not set)

```json
"compose_files": ["docker/compose.yaml"]
```

### `required_services`

**Required.** Array of services that must be running for the pipeline to start. Each entry is either a string or an object:

```json
// Simple — just check that it's running
"required_services": ["postgres", "redis"]

// With healthcheck — must be running AND healthy
"required_services": [
  { "name": "postgres", "healthcheck": true },
  { "name": "redis",    "healthcheck": true }
]
```

When `healthcheck: true`, the service must report `healthy` status (Docker healthcheck). Services that are `running` but `unhealthy` or `starting` will fail the check.

### `optional_services`

Optional. Array of service names to display in status but not block on. Useful for monitoring — you see them in the TUI but they don't prevent tasks from running.

### `healthcheck_urls`

Optional. Array of HTTP endpoints to probe with `curl -sf --max-time 3`. Each entry:

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | Full URL to probe |
| `label` | string | Human-readable name for error messages |
| `required` | boolean | `true` = pipeline fails if unreachable |

### `commands`

Optional. Array of shell commands to run. Useful for checking that tools like `php`, `node`, `composer` are available.

| Field | Type | Description |
|-------|------|-------------|
| `cmd` | string | Shell command to execute |
| `label` | string | Human-readable name for error messages |
| `required` | boolean | `true` = pipeline fails if command fails |

Note: `docker info` is checked automatically — you can include it in `commands` for documentation but it's always verified first.

### `up_command`

Optional. Custom command to start the environment. Used when pressing `[e]` in the TUI. If not set, the command is built from `compose_files`:

```
docker compose -f <file1> -f <file2> ... up -d
```

## How the check works

The env-check runs at two points:

### 1. TUI (every 30 seconds, async)

```
checkEnvStatusAsync(repoRoot, callback)
```

Non-blocking. Updates the header indicator without freezing the UI.

### 2. Pipeline runner (before first agent, sync)

```
runPipeline(config)
  └─ if (!config.skipEnvCheck)
       └─ checkEnvStatus(repoRoot)
            └─ if not ready → fail task with "env-check" error
```

The check sequence:

1. **Load config** — read `env-check.json` (fail if missing)
2. **Docker daemon** — `docker info` (fail if not running)
3. **Commands** — run each from `commands[]`
4. **Compose services** — `docker compose ps --format json --all`
5. **Required services** — verify each is running (+ healthy if configured)
6. **Healthcheck URLs** — `curl -sf` each required URL

If any required check fails, the pipeline task is marked `failed` with `failedAgent: "env-check"` and the errors are written to `handoff.md`.

## Skipping the check

For rare cases where you need to run a pipeline without env validation:

```bash
foundry run --skip-env-check "My task"
```

Or in the pipeline config:

```typescript
const config: PipelineConfig = {
  skipEnvCheck: true,
  // ...
};
```

## Examples

### Minimal (services only)

```json
{
  "compose_files": ["docker/compose.yaml"],
  "required_services": ["postgres", "redis"]
}
```

### Full stack with agents

```json
{
  "compose_files": [
    "docker/compose.yaml",
    "docker/compose.core.yaml"
  ],
  "required_services": [
    { "name": "postgres",  "healthcheck": true },
    { "name": "redis",     "healthcheck": true },
    { "name": "rabbitmq",  "healthcheck": true }
  ],
  "optional_services": [
    "traefik",
    "litellm",
    "opensearch"
  ],
  "healthcheck_urls": [
    { "url": "http://localhost:15672", "label": "RabbitMQ management", "required": false }
  ],
  "commands": [
    { "cmd": "docker info",   "label": "Docker daemon",  "required": true },
    { "cmd": "git --version", "label": "Git",            "required": true }
  ],
  "up_command": "docker compose -f docker/compose.yaml -f docker/compose.core.yaml up -d"
}
```

### Python project (no compose)

```json
{
  "compose_files": [],
  "required_services": [],
  "commands": [
    { "cmd": "python3 --version", "label": "Python 3",  "required": true },
    { "cmd": "pip --version",     "label": "pip",        "required": true }
  ]
}
```

### Node.js agent

```json
{
  "compose_files": ["docker-compose.yml"],
  "required_services": [
    { "name": "mongo", "healthcheck": true }
  ],
  "commands": [
    { "cmd": "node --version", "label": "Node.js", "required": true },
    { "cmd": "npm --version",  "label": "npm",     "required": true }
  ]
}
```

## Troubleshooting

### `? ENV env-check.json missing`

Create `env-check.json` in the project root. See the examples above.

### `✗ ENV postgres: exited`

The service exists but is not running. Press `[e]` in the TUI or run:

```bash
docker compose -f docker/compose.yaml up -d postgres
```

### `✗ ENV redis: unhealthy`

The service is running but its healthcheck is failing. Check container logs:

```bash
docker compose -f docker/compose.yaml logs redis
```

### `✗ ENV No compose services found`

The Docker Compose stack has never been started. Press `[e]` or run the `up_command` from your config.

### Pipeline fails with `failedAgent: "env-check"`

The environment was not ready when the pipeline started. Fix the issues listed in `handoff.md`, then retry the task.
