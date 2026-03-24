#!/usr/bin/env bash
set -euo pipefail

# Ensure mounted tool state remains writable by the vscode user after container recreate/restart.
fix_dir() {
  local dir="$1"
  if [ -e "$dir" ]; then
    sudo chown -R vscode:vscode "$dir" 2>/dev/null || true
  fi
}

# Create common user-state directories up front so CLI tools do not fail on first run.
ensure_dir() {
  local dir="$1"
  sudo mkdir -p "$dir" 2>/dev/null || true
  fix_dir "$dir"
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
fix_dir /home/vscode/.local
fix_dir /home/vscode/.claude
fix_dir /home/vscode/.codex
fix_dir /home/vscode/.cursor
fix_dir /home/vscode/.gemini
fix_dir /home/vscode/.npm
fix_dir /home/vscode/.bun
fix_dir /home/vscode/.kube
fix_dir /home/vscode/.config/Cursor
fix_dir /home/vscode/.config/opencode
fix_dir /home/vscode/.local/share/opencode
fix_dir /commandhistory

touch /commandhistory/.bash_history /commandhistory/.zsh_history 2>/dev/null || true
fix_dir /commandhistory

history_snippet='[ -f /workspaces/brama/.devcontainer/shell-history.sh ] && . /workspaces/brama/.devcontainer/shell-history.sh'

append_history_hook() {
  local rc_file="$1"
  if [ -f "$rc_file" ] && ! grep -Fq "$history_snippet" "$rc_file"; then
    printf '\n%s\n' "$history_snippet" >> "$rc_file"
  fi
}

append_history_hook /home/vscode/.bashrc
append_history_hook /home/vscode/.zshrc

# Install a devcontainer-only OpenCode override that runs in full-trust mode.
# This keeps host sessions safer while making the container workflow non-interrupting.
sudo install -d -m 755 -o vscode -g vscode /home/vscode/.config/opencode 2>/dev/null || true
sudo install -m 644 -o vscode -g vscode \
  /workspaces/brama/.devcontainer/opencode.devcontainer.json \
  /home/vscode/.config/opencode/opencode.json 2>/dev/null || true

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

ssh_snippet='# SSH agent: reuse running agent across shell sessions
if [ -f "$HOME/.ssh/agent.env" ]; then . "$HOME/.ssh/agent.env" > /dev/null; fi'

# Kubernetes: shell completion and aliases for kubectl/helm
k8s_snippet='# Kubernetes shell helpers
command -v kubectl &>/dev/null && { source <(kubectl completion $(basename "$SHELL" 2>/dev/null || echo bash)); alias k=kubectl; }
command -v helm &>/dev/null && source <(helm completion $(basename "$SHELL" 2>/dev/null || echo bash))'

# Claude Code: always run in dangerously-skip-permissions mode inside devcontainer.
claude_alias='alias claude="claude --dangerously-skip-permissions"'
for rc_file in /home/vscode/.bashrc /home/vscode/.zshrc; do
  if [ -f "$rc_file" ] && ! grep -Fq 'agent.env' "$rc_file"; then
    printf '\n%s\n' "$ssh_snippet" >> "$rc_file"
  fi
  if [ -f "$rc_file" ] && ! grep -Fq 'dangerously-skip-permissions' "$rc_file"; then
    printf '\n# Claude Code: bypass permissions in devcontainer\n%s\n' "$claude_alias" >> "$rc_file"
  fi
  if [ -f "$rc_file" ] && ! grep -Fq 'kubectl completion' "$rc_file"; then
    printf '\n%s\n' "$k8s_snippet" >> "$rc_file"
  fi
done
