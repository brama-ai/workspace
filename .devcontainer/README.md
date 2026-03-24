# Devcontainer: SSH Setup

How to configure SSH keys for git, remote servers, and AI agent access (MCP SSH).

## Quick start

```bash
# 1. Generate a dedicated key (if you don't have one yet)
ssh-keygen -t ed25519 -C "your@email.com" -f ~/.ssh/ai_platform

# 2. Copy the public key to the remote server
ssh-copy-id -i ~/.ssh/ai_platform.pub root@46.62.135.86

# 3. Create your local SSH config
cp .devcontainer/.ssh-env.example .devcontainer/.ssh-env

# 4. Edit .ssh-env with your values
# 5. Rebuild devcontainer (or run post-start.sh manually)
bash .devcontainer/post-start.sh

# 6. If your keys have a passphrase, add them manually (once per session)
ssh-add ~/.ssh/ai_platform
ssh-add ~/.ssh/brama
```

## Step by step

### 1. Generate an SSH key

If you already have a key you want to use, skip to step 2.

```bash
ssh-keygen -t ed25519 -C "your@email.com" -f ~/.ssh/ai_platform
```

- `-t ed25519` -- modern, fast, secure algorithm
- `-f ~/.ssh/ai_platform` -- key filename (use any name you like)
- When prompted for passphrase, press Enter for no passphrase (required for agent automation), or set one and use `ssh-agent`

This creates two files:
- `~/.ssh/ai_platform` -- private key (never share this)
- `~/.ssh/ai_platform.pub` -- public key (goes on the server)

### 2. Add the key to the remote server

```bash
# Option A: ssh-copy-id (easiest)
ssh-copy-id -i ~/.ssh/ai_platform.pub root@YOUR_SERVER_IP

# Option B: manual
cat ~/.ssh/ai_platform.pub | ssh root@YOUR_SERVER_IP "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

Verify it works:

```bash
ssh -i ~/.ssh/ai_platform root@YOUR_SERVER_IP "echo ok"
```

### 3. Configure .ssh-env

```bash
cp .devcontainer/.ssh-env.example .devcontainer/.ssh-env
```

Edit `.devcontainer/.ssh-env`:

```bash
# Remote server access
REMOTE_SSH_HOST=46.62.135.86
REMOTE_SSH_PORT=22
REMOTE_SSH_USER=root
REMOTE_SSH_KEY=ai_platform

# Auto-load keys into ssh-agent on container start
SSH_AGENT_KEYS=id_ed25519,ai_platform

# MCP SSH server defaults (used by OpenCode AI agent)
SSH_MCP_DEFAULT_USERNAME=root
SSH_MCP_DEFAULT_KEY=~/.ssh/ai_platform
```

This file is **gitignored** -- your credentials stay local.

### 4. Rebuild devcontainer

After editing `.ssh-env`, rebuild the devcontainer or run the script manually:

```bash
bash /workspaces/brama/.devcontainer/post-start.sh
```

On startup, `post-start.sh` will:

1. Load all variables from `.ssh-env`
2. Add keys listed in `SSH_AGENT_KEYS` to the SSH agent (keys without passphrase)
3. Generate `~/.ssh-generated/config` with Host entries
4. Inject MCP SSH environment into OpenCode config

You should see in the startup log:

```
  [OK]   ssh-add: brama
  [WARN] ssh-add: ai_platform — has passphrase, run 'ssh-add ~/.ssh/ai_platform' manually
  [OK]   SSH environment loaded from .ssh-env
```

> **Keys with passphrase:** Cannot be added automatically in non-interactive mode.
> Add them manually once per session: `ssh-add ~/.ssh/ai_platform`

### 5. Verify

Inside the devcontainer:

```bash
# Check SSH agent has your keys
ssh-add -l

# Test connection via generated config
ssh -F ~/.ssh-generated/config remote "hostname && uptime"
# Or in a new terminal (alias is set in .bashrc/.zshrc):
ssh remote "hostname && uptime"

# Check OpenCode MCP tools are available
opencode mcp list
```

## What .ssh-env configures

| Variable | What it does |
|----------|-------------|
| `REMOTE_SSH_HOST` | Server IP/hostname |
| `REMOTE_SSH_PORT` | SSH port (default: 22) |
| `REMOTE_SSH_USER` | Username (default: root) |
| `REMOTE_SSH_KEY` | Key filename in `~/.ssh/` |
| `REMOTE_SSH_HOST_2` ... `_9` | Additional servers (same pattern with suffix) |
| `SSH_AGENT_KEYS` | Comma-separated key filenames to auto-add to agent |
| `SSH_MCP_DEFAULT_USERNAME` | Default user for MCP SSH tool calls |
| `SSH_MCP_DEFAULT_KEY` | Default key path for MCP SSH tool calls |
| `SSH_MCP_IDLE_TIMEOUT` | MCP connection idle timeout in ms (default: 1800000) |
| `SSH_MCP_EXEC_TIMEOUT` | MCP command execution timeout in ms (default: 30000) |
| `SSH_MCP_ALLOWED_HOSTS` | Restrict MCP connections to these host patterns |

## Multiple servers

Use numbered suffixes for additional servers:

```bash
# Primary server -> alias "remote"
REMOTE_SSH_HOST=46.62.135.86
REMOTE_SSH_USER=root
REMOTE_SSH_KEY=ai_platform

# Second server -> alias "remote_2"
REMOTE_SSH_HOST_2=10.0.0.5
REMOTE_SSH_USER_2=deploy
REMOTE_SSH_KEY_2=deploy_key

# Third server -> alias "remote_3"
REMOTE_SSH_HOST_3=staging.example.com
REMOTE_SSH_USER_3=ubuntu
REMOTE_SSH_KEY_3=id_ed25519
```

Then inside devcontainer:

```bash
ssh remote       # -> root@46.62.135.86
ssh remote_2     # -> deploy@10.0.0.5
ssh remote_3     # -> ubuntu@staging.example.com
```

## Using with OpenCode (MCP SSH)

Once configured, OpenCode has access to SSH tools via the `mcp-server-ssh` MCP server. The AI agent can:

- Connect to servers (`ssh_connect`)
- Execute commands (`ssh_exec`)
- Transfer files via SFTP (`sftp_read`, `sftp_write`, `sftp_ls`, ...)
- Get system info (`ssh_system_info`)
- Set up port forwarding (`ssh_port_forward`)

Example prompt:

```
Connect to the remote server and check disk usage
```

The agent will use `SSH_MCP_DEFAULT_USERNAME` and `SSH_MCP_DEFAULT_KEY` from your `.ssh-env` automatically.

## Git SSH key

If you use SSH for git (instead of HTTPS), add your git key:

```bash
GIT_SSH_KEY=id_ed25519
SSH_AGENT_KEYS=id_ed25519
```

The key is mounted from your host `~/.ssh/` into the container automatically via docker-compose volume.

## Troubleshooting

### "Permission denied (publickey)"

- Check the key exists on host: `ls -la ~/.ssh/ai_platform`
- Check it's in the agent: `ssh-add -l` (inside devcontainer)
- Check `SSH_AGENT_KEYS` includes the key filename in `.ssh-env`
- Verify the public key is on the server: `ssh root@HOST "cat ~/.ssh/authorized_keys"`

### "No .ssh-env found" on startup

Expected if you haven't created the file yet. Copy the example:

```bash
cp .devcontainer/.ssh-env.example .devcontainer/.ssh-env
```

### MCP SSH tools not showing in OpenCode

- Check: `opencode mcp list` -- should show `ssh` server
- The MCP server starts on first use via `npx -y mcp-server-ssh`
- Requires Node.js 18+ (included in the devcontainer image)

### SSH config not generated

- Verify `.ssh-env` has `REMOTE_SSH_HOST` set (not commented out)
- Check: `cat ~/.ssh/config.devcontainer` inside the container
- Check: `grep config.devcontainer ~/.ssh/config` -- should show Include line
