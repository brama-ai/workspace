#!/usr/bin/env bash
set -euo pipefail

# Ensure mounted tool state remains writable by the vscode user after container recreate/restart.
# Keep runtime fixes shallow so reconnects do not traverse large host-mounted caches.
fix_dir() {
  local dir="$1"
  if [ -e "$dir" ]; then
    sudo chown vscode:vscode "$dir" 2>/dev/null || true
  fi
}

# fix_dir_shallow: non-recursive — fix only the directory itself (not contents).
# Use for dirs that may contain root-owned subdirs (e.g. opencode snapshot git objects).
fix_dir_shallow() {
  local dir="$1"
  if [ -e "$dir" ]; then
    sudo chown vscode:vscode "$dir" 2>/dev/null || true
  fi
}

# Create common user-state directories up front so CLI tools do not fail on first run.
ensure_dir() {
  local dir="$1"
  sudo mkdir -p "$dir" 2>/dev/null || true
  fix_dir_shallow "$dir"
}

ensure_dir /home/vscode/.cache
ensure_dir /home/vscode/.npm
ensure_dir /home/vscode/.bun
ensure_dir /home/vscode/.codex
ensure_dir /home/vscode/.cursor
ensure_dir /home/vscode/.gemini
ensure_dir /home/vscode/.local
ensure_dir /home/vscode/.local/state
ensure_dir /home/vscode/.local/share
ensure_dir /home/vscode/.config
ensure_dir /home/vscode/.config/Cursor
ensure_dir /home/vscode/.config/opencode
ensure_dir /commandhistory

fix_dir /home/vscode/.antigravity-server
fix_dir /home/vscode/.vscode-server
fix_dir /home/vscode/.claude
fix_dir /home/vscode/.codex
fix_dir /home/vscode/.cursor
fix_dir /home/vscode/.gemini
fix_dir /home/vscode/.npm
fix_dir /home/vscode/.bun
fix_dir /home/vscode/.kube
fix_dir /home/vscode/.config/Cursor
fix_dir /home/vscode/.config/opencode
# .local/share/opencode contains snapshot/ with root-owned git objects —
# recursive chown fails on those and can leave parent dirs root-owned.
# Fix only the top-level dirs that CLI tools need to mkdir into.
fix_dir_shallow /home/vscode/.local/share/opencode
fix_dir /commandhistory

touch /commandhistory/.bash_history /commandhistory/.zsh_history 2>/dev/null || true
fix_dir /commandhistory
fix_dir /commandhistory/.bash_history
fix_dir /commandhistory/.zsh_history

history_snippet='[ -f /workspaces/brama/.devcontainer/shell-history.sh ] && . /workspaces/brama/.devcontainer/shell-history.sh'

append_history_hook() {
  local rc_file="$1"
  if [ -f "$rc_file" ] && ! grep -Fq "$history_snippet" "$rc_file"; then
    printf '\n%s\n' "$history_snippet" >> "$rc_file"
  fi
}

append_history_hook /home/vscode/.bashrc
append_history_hook /home/vscode/.zshrc

# Install a devcontainer-only OpenCode baseline without clobbering user plugins or auth state.
sudo install -d -m 755 -o vscode -g vscode /home/vscode/.config/opencode 2>/dev/null || true
_opencode_config="/home/vscode/.config/opencode/opencode.json"
if command -v jq &>/dev/null; then
  if [ -f "$_opencode_config" ]; then
    jq -s '.[0] * .[1]' \
      /workspaces/brama/.devcontainer/opencode.devcontainer.json \
      "$_opencode_config" > "${_opencode_config}.tmp" \
      && mv "${_opencode_config}.tmp" "$_opencode_config"
  else
    install -m 644 /workspaces/brama/.devcontainer/opencode.devcontainer.json "$_opencode_config"
  fi
else
  [ -f "$_opencode_config" ] || install -m 644 /workspaces/brama/.devcontainer/opencode.devcontainer.json "$_opencode_config"
fi
chown vscode:vscode "$_opencode_config" 2>/dev/null || true
unset _opencode_config

# Docker socket permissions are not stable across recreates on macOS Docker Desktop.
if [ -S /var/run/docker.sock ]; then
  sudo chmod 666 /var/run/docker.sock 2>/dev/null || true
fi

# Kubernetes: create a devcontainer-local kubeconfig with 127.0.0.1 → host.docker.internal
# (Rancher Desktop / Docker Desktop K3S API server is on the host, not in-container localhost)
if [ -f /home/vscode/.kube/config ]; then
  kube_dev="/home/vscode/.kube/config.devcontainer"
  cp /home/vscode/.kube/config "$kube_dev" 2>/dev/null || true
  if grep -q '127\.0\.0\.1' "$kube_dev" 2>/dev/null; then
    sed -i 's|https://127\.0\.0\.1:|https://host.docker.internal:|g' "$kube_dev" 2>/dev/null || true
  fi
  chown vscode:vscode "$kube_dev" 2>/dev/null || true
fi

# SSH agent: prefer the host agent forwarded by Dev Containers.
# Only fall back to a container-local agent when no forwarded socket is available.
ssh_env="/home/vscode/.ssh/agent.env"
if [ -z "${SSH_AUTH_SOCK:-}" ] && [ -f "$ssh_env" ]; then
  . "$ssh_env" > /dev/null
fi

if [ -n "${SSH_AUTH_SOCK:-}" ] && ssh-add -l &>/dev/null; then
  :
elif [ -n "${SSH_AUTH_SOCK:-}" ] && [ -S "${SSH_AUTH_SOCK}" ]; then
  # A forwarded agent may legitimately have no identities yet.
  :
else
  eval "$(ssh-agent -s)" > /dev/null
  echo "export SSH_AUTH_SOCK=$SSH_AUTH_SOCK" > "$ssh_env"
  echo "export SSH_AGENT_PID=$SSH_AGENT_PID" >> "$ssh_env"
fi

# ---------------------------------------------------------------------------
# .ssh-env: load developer SSH configuration
# ---------------------------------------------------------------------------
SSH_ENV_FILE="/workspaces/brama/.devcontainer/.ssh-env"
if [ -f "$SSH_ENV_FILE" ]; then
  # Source .ssh-env (only KEY=VALUE lines, skip comments and blanks)
  set -a
  # shellcheck disable=SC1090
  . "$SSH_ENV_FILE"
  set +a

  # Auto-add keys to the running SSH agent.
  # For keys with passphrase: uses REMOTE_SSH_KEY_PASSPHRASE (or _N suffix) via SSH_ASKPASS.
  if [ -n "${SSH_AGENT_KEYS:-}" ]; then
    IFS=',' read -ra _keys <<< "$SSH_AGENT_KEYS"
    for _key in "${_keys[@]}"; do
      _key_path="/home/vscode/.ssh/${_key}"
      if [ ! -f "$_key_path" ]; then
        echo "  [WARN] ssh-add: ${_key} — key file not found"
        continue
      fi

      # Try without passphrase first
      if SSH_ASKPASS=/bin/false DISPLAY= ssh-add "$_key_path" </dev/null 2>/dev/null; then
        echo "  [OK]   ssh-add: ${_key}"
        continue
      fi

      # Key has passphrase — look up matching passphrase from .ssh-env.
      # Match by REMOTE_SSH_KEY value: find which REMOTE_SSH_KEY[_N] == _key,
      # then use the corresponding REMOTE_SSH_KEY_PASSPHRASE[_N].
      _passphrase=""
      for _suffix in "" $(seq 2 9 | sed 's/^/_/'); do
        _kvar="REMOTE_SSH_KEY${_suffix}"
        if [ "${!_kvar:-}" = "$_key" ]; then
          _pvar="REMOTE_SSH_KEY_PASSPHRASE${_suffix}"
          _passphrase="${!_pvar:-}"
          break
        fi
      done

      if [ -n "$_passphrase" ]; then
        # Create a temporary askpass script that echoes the passphrase
        _askpass="$(mktemp)"
        printf '#!/bin/sh\necho "%s"\n' "$_passphrase" > "$_askpass"
        chmod +x "$_askpass"
        if DISPLAY=:0 SSH_ASKPASS="$_askpass" SSH_ASKPASS_REQUIRE=force ssh-add "$_key_path" </dev/null 2>/dev/null; then
          echo "  [OK]   ssh-add: ${_key} (with passphrase)"
        else
          echo "  [FAIL] ssh-add: ${_key} — passphrase rejected"
        fi
        rm -f "$_askpass"
      else
        echo "  [WARN] ssh-add: ${_key} — has passphrase, set REMOTE_SSH_KEY_PASSPHRASE in .ssh-env or run 'ssh-add ~/.ssh/${_key}' manually"
      fi
    done
    unset _keys _key _key_path _passphrase _askpass _suffix _kvar _pvar
  fi

  # Build SSH config entries from REMOTE_SSH_* variables.
  # Write to a writable location (host ~/.ssh may be mounted read-only).
  _ssh_config_dir="/home/vscode/.ssh-generated"
  sudo mkdir -p "$_ssh_config_dir" 2>/dev/null || true
  sudo chown vscode:vscode "$_ssh_config_dir" 2>/dev/null || true
  _ssh_config="${_ssh_config_dir}/config"
  : > "$_ssh_config"

  _write_host_block() {
    local suffix="$1"
    local host_var="REMOTE_SSH_HOST${suffix}"
    local port_var="REMOTE_SSH_PORT${suffix}"
    local user_var="REMOTE_SSH_USER${suffix}"
    local key_var="REMOTE_SSH_KEY${suffix}"

    local host="${!host_var:-}"
    [ -z "$host" ] && return

    local port="${!port_var:-22}"
    local user="${!user_var:-root}"
    local key="${!key_var:-}"

    {
      echo "Host remote${suffix:+${suffix}}"
      echo "  HostName $host"
      echo "  Port $port"
      echo "  User $user"
      [ -n "$key" ] && echo "  IdentityFile ~/.ssh/$key"
      echo "  StrictHostKeyChecking no"
      echo "  UserKnownHostsFile /dev/null"
      echo ""
    } >> "$_ssh_config"
  }

  # Primary server (no suffix)
  _write_host_block ""
  # Numbered servers (_2, _3, ... _9)
  for _i in $(seq 2 9); do
    _write_host_block "_${_i}"
  done
  unset _i

  # Point SSH at the generated config via environment (avoids writing to read-only ~/.ssh/)
  if [ -s "$_ssh_config" ]; then
    _ssh_env_line="export SSH_CONFIG_FILE=${_ssh_config}"
    # Also create a shell snippet that sets SSH_CONFIG and an alias so plain `ssh` picks it up
    _ssh_rc_snippet="# SSH generated config from .ssh-env
export SSH_GENERATED_CONFIG=\"${_ssh_config}\"
alias ssh='ssh -F ${_ssh_config}'"
    for _rc in /home/vscode/.bashrc /home/vscode/.zshrc; do
      if [ -f "$_rc" ] && ! grep -Fq 'SSH_GENERATED_CONFIG' "$_rc" 2>/dev/null; then
        printf '\n%s\n' "$_ssh_rc_snippet" >> "$_rc"
      fi
    done
    unset _ssh_env_line _ssh_rc_snippet _rc

    # Also copy host ~/.ssh/config content into generated config so existing entries work.
    # Filter out macOS-only directives (UseKeychain, AddKeysToAgent) that break Linux SSH.
    if [ -f /home/vscode/.ssh/config ]; then
      echo "# --- Host SSH config ---" >> "$_ssh_config"
      grep -vi '^\s*UseKeychain\|^\s*AddKeysToAgent' /home/vscode/.ssh/config >> "$_ssh_config" || true
    fi
  fi
  unset _ssh_config _ssh_config_dir

  # Inject MCP SSH defaults into the OpenCode config
  _oc_config="/home/vscode/.config/opencode/opencode.json"
  if [ -f "$_oc_config" ] && command -v jq &>/dev/null; then
    _mcp_env='{}'

    [ -n "${SSH_MCP_DEFAULT_USERNAME:-}" ] && \
      _mcp_env=$(echo "$_mcp_env" | jq --arg v "$SSH_MCP_DEFAULT_USERNAME" '. + {SSH_MCP_DEFAULT_USERNAME: $v}')
    [ -n "${SSH_MCP_DEFAULT_KEY:-}" ] && \
      _mcp_env=$(echo "$_mcp_env" | jq --arg v "$SSH_MCP_DEFAULT_KEY" '. + {SSH_MCP_DEFAULT_KEY: $v}')
    [ -n "${SSH_MCP_IDLE_TIMEOUT:-}" ] && \
      _mcp_env=$(echo "$_mcp_env" | jq --arg v "$SSH_MCP_IDLE_TIMEOUT" '. + {SSH_MCP_IDLE_TIMEOUT: $v}')
    [ -n "${SSH_MCP_EXEC_TIMEOUT:-}" ] && \
      _mcp_env=$(echo "$_mcp_env" | jq --arg v "$SSH_MCP_EXEC_TIMEOUT" '. + {SSH_MCP_EXEC_TIMEOUT: $v}')
    [ -n "${SSH_MCP_ALLOWED_HOSTS:-}" ] && \
      _mcp_env=$(echo "$_mcp_env" | jq --arg v "$SSH_MCP_ALLOWED_HOSTS" '. + {SSH_MCP_ALLOWED_HOSTS: $v}')
    [ -n "${SSH_MCP_STRICT_HOST_CHECK:-}" ] && \
      _mcp_env=$(echo "$_mcp_env" | jq --arg v "$SSH_MCP_STRICT_HOST_CHECK" '. + {SSH_MCP_STRICT_HOST_CHECK: $v}')

    if [ "$_mcp_env" != '{}' ]; then
      jq --argjson env "$_mcp_env" '.mcp.ssh.environment = (.mcp.ssh.environment // {} | . + $env)' \
        "$_oc_config" > "${_oc_config}.tmp" && mv "${_oc_config}.tmp" "$_oc_config"
      chown vscode:vscode "$_oc_config" 2>/dev/null || true
    fi
    unset _mcp_env
  fi
  unset _oc_config

  echo "  [OK]   SSH environment loaded from .ssh-env"
else
  echo "  [SKIP] No .ssh-env found (copy .ssh-env.example to .ssh-env to configure)"
fi

# ---------------------------------------------------------------------------
# OpenCode server: headless server for TelegramCoder and web UI
# ---------------------------------------------------------------------------
if command -v opencode &>/dev/null; then
  pkill -f "opencode serve" 2>/dev/null || true
  sleep 1
  (nohup opencode serve --port 4096 >> /tmp/opencode-serve.log 2>&1 &)
  echo "  [OK]   OpenCode server started on :4096 (log: /tmp/opencode-serve.log)"
else
  echo "  [SKIP] OpenCode not installed"
fi

# ---------------------------------------------------------------------------
# Cloudflare Tunnel: expose services via named tunnel
# ---------------------------------------------------------------------------
if command -v cloudflared &>/dev/null && [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
  pkill -f "cloudflared.*tunnel" 2>/dev/null || true
  sleep 1
  (nohup cloudflared tunnel --no-autoupdate run --token "$CLOUDFLARE_TUNNEL_TOKEN" >> /tmp/cloudflared.log 2>&1 &)
  echo "  [OK]   Cloudflare tunnel started (log: /tmp/cloudflared.log)"
elif command -v cloudflared &>/dev/null; then
  echo "  [SKIP] Cloudflare tunnel: CLOUDFLARE_TUNNEL_TOKEN not set in .env.local"
else
  echo "  [SKIP] cloudflared not installed"
fi

# ---------------------------------------------------------------------------
# TelegramCoder: start the Telegram terminal bot in the background
# ---------------------------------------------------------------------------
_tc_dir="/home/vscode/.local/share/telegramcoder"
if [ -d "$_tc_dir" ] && [ -f "$_tc_dir/dist/app.js" ]; then
  # Kill any previous instance
  pkill -f "node.*telegramcoder.*app.js" 2>/dev/null || true
  (cd "$_tc_dir" && nohup node dist/app.js >> /tmp/telegramcoder.log 2>&1 &)
  echo "  [OK]   TelegramCoder bot started (log: /tmp/telegramcoder.log)"
else
  echo "  [SKIP] TelegramCoder not installed"
fi
unset _tc_dir

ssh_snippet='# SSH agent: reuse running agent across shell sessions
if [ -f "$HOME/.ssh/agent.env" ]; then . "$HOME/.ssh/agent.env" > /dev/null; fi'

# Kubernetes: shell completion and aliases for kubectl/helm
k8s_snippet='# Kubernetes shell helpers
command -v kubectl &>/dev/null && { source <(kubectl completion $(basename "$SHELL" 2>/dev/null || echo bash)); alias k=kubectl; }
command -v helm &>/dev/null && source <(helm completion $(basename "$SHELL" 2>/dev/null || echo bash))'

# Claude Code: auto-approve all tools inside devcontainer via project-level settings.
# This replaces --dangerously-skip-permissions so the VSCode extension shows full UI.
_claude_project_dir="/home/vscode/.claude/projects/-workspaces-brama"
ensure_dir "$_claude_project_dir"
_claude_settings="${_claude_project_dir}/settings.json"
if command -v jq &>/dev/null; then
  if [ -f "$_claude_settings" ]; then
    jq '
      .permissions = (.permissions // {}) |
      .permissions.allow = (
        (.permissions.allow // []) + [
          "Bash(*)",
          "Read(*)",
          "Write(*)",
          "Edit(*)",
          "Glob(*)",
          "Grep(*)",
          "WebFetch(*)",
          "WebSearch(*)",
          "Agent(*)",
          "NotebookEdit(*)"
        ] | unique
      )
    ' "$_claude_settings" > "${_claude_settings}.tmp" && mv "${_claude_settings}.tmp" "$_claude_settings"
  else
    cat > "$_claude_settings" <<'CLAUDE_EOF'
{
  "permissions": {
    "allow": [
      "Bash(*)",
      "Read(*)",
      "Write(*)",
      "Edit(*)",
      "Glob(*)",
      "Grep(*)",
      "WebFetch(*)",
      "WebSearch(*)",
      "Agent(*)",
      "NotebookEdit(*)"
    ]
  }
}
CLAUDE_EOF
  fi
else
  [ -f "$_claude_settings" ] || cat > "$_claude_settings" <<'CLAUDE_EOF'
{
  "permissions": {
    "allow": [
      "Bash(*)",
      "Read(*)",
      "Write(*)",
      "Edit(*)",
      "Glob(*)",
      "Grep(*)",
      "WebFetch(*)",
      "WebSearch(*)",
      "Agent(*)",
      "NotebookEdit(*)"
    ]
  }
}
CLAUDE_EOF
fi
chown vscode:vscode "$_claude_settings" 2>/dev/null || true
unset _claude_settings
unset _claude_project_dir

for rc_file in /home/vscode/.bashrc /home/vscode/.zshrc; do
  if [ -f "$rc_file" ] && ! grep -Fq 'agent.env' "$rc_file"; then
    printf '\n%s\n' "$ssh_snippet" >> "$rc_file"
  fi
  if [ -f "$rc_file" ] && ! grep -Fq 'kubectl completion' "$rc_file"; then
    printf '\n%s\n' "$k8s_snippet" >> "$rc_file"
  fi
done
