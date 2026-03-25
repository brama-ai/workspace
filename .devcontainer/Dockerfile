FROM mcr.microsoft.com/devcontainers/base:ubuntu

# Ensure /tmp is writable
RUN chmod 1777 /tmp

ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install Docker CLI for Docker-in-Docker
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl gnupg lsb-release \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
       $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Node.js LTS
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g npm@latest

# Install PHP 8.5 from ondrej/php PPA
RUN apt-get update \
    && apt-get install -y --no-install-recommends software-properties-common \
    && add-apt-repository ppa:ondrej/php \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       php8.5-cli php8.5-common php8.5-curl php8.5-mbstring php8.5-xml \
       php8.5-zip php8.5-intl php8.5-pgsql php8.5-redis \
       php8.5-xdebug php8.5-bcmath php8.5-gd \
       php8.5-apcu php8.5-rdkafka php8.5-amqp php8.5-mongodb \
       php8.5-memcached php8.5-mysql php8.5-sqlite3 php8.5-soap \
       php8.5-imagick php8.5-protobuf php8.5-opentelemetry \
       php8.5-yaml php8.5-uuid php8.5-msgpack \
       php8.5-lz4 php8.5-zstd php8.5-pcov php8.5-ssh2 php8.5-http php8.5-ds \
       sox \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install PostgreSQL client, Redis CLI, tmux
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-16 redis-tools tmux \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install kubectl
RUN ARCH=$(dpkg --print-architecture) \
    && curl -fsSL "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/${ARCH}/kubectl" \
       -o /usr/local/bin/kubectl \
    && chmod +x /usr/local/bin/kubectl

# Install Helm
RUN curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# Install k9s (Kubernetes TUI)
RUN ARCH=$(dpkg --print-architecture) \
    && K9S_VERSION=$(curl -fsSL https://api.github.com/repos/derailed/k9s/releases/latest | grep tag_name | cut -d '"' -f 4) \
    && if [ "$ARCH" = "amd64" ]; then K9S_ARCH="amd64"; else K9S_ARCH="arm64"; fi \
    && curl -fsSL "https://github.com/derailed/k9s/releases/download/${K9S_VERSION}/k9s_Linux_${K9S_ARCH}.tar.gz" \
       | tar -C /usr/local/bin -xzf - k9s

# Install Composer
RUN php -r "copy('https://getcomposer.org/installer', 'composer-setup.php');" \
    && php composer-setup.php --install-dir=/usr/local/bin --filename=composer \
    && rm composer-setup.php

# Install pip
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-pip \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Go dynamically based on architecture
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then GOARCH="amd64"; else GOARCH="arm64"; fi && \
    curl -fsSL "https://go.dev/dl/go1.24.1.linux-${GOARCH}.tar.gz" | tar -C /usr/local -xzf -
ENV PATH="/usr/local/go/bin:${PATH}"

# Install global npm tools
RUN npm install -g opencode-ai bun typescript ts-node @fission-ai/openspec intelephense @anthropic-ai/claude-code

# Preinstall Playwright browser dependencies and binaries so they cache in the image.
COPY brama-core/tests/e2e/package.json brama-core/tests/e2e/package-lock.json /tmp/tests-e2e/
RUN cd /tmp/tests-e2e \
    && npm ci \
    && npx playwright install --with-deps \
    && rm -rf /tmp/tests-e2e

# Ensure user-state directories exist with correct ownership before volume mounts.
# Docker auto-creates intermediate dirs as root when mounting sub-paths (e.g. .local/share/opencode),
# which prevents the vscode user from creating siblings like .local/state at runtime.
RUN mkdir -p /home/vscode/.claude \
    /home/vscode/.local/state \
    /home/vscode/.local/share \
    /home/vscode/.config/opencode \
    /home/vscode/.config/Cursor \
    && chown -R vscode:vscode /home/vscode/.local /home/vscode/.config /home/vscode/.claude \
    && mkdir -p "${PLAYWRIGHT_BROWSERS_PATH}" \
    && chown -R vscode:vscode "${PLAYWRIGHT_BROWSERS_PATH}"

# Load persistent shell history settings for both bash and zsh in the devcontainer.
RUN grep -Fq '.devcontainer/shell-history.sh' /home/vscode/.zshrc \
      || printf '\n[ -f /workspaces/brama/.devcontainer/shell-history.sh ] && . /workspaces/brama/.devcontainer/shell-history.sh\n' >> /home/vscode/.zshrc \
    && grep -Fq '.devcontainer/shell-history.sh' /home/vscode/.bashrc \
      || printf '\n[ -f /workspaces/brama/.devcontainer/shell-history.sh ] && . /workspaces/brama/.devcontainer/shell-history.sh\n' >> /home/vscode/.bashrc \
    && chown vscode:vscode /home/vscode/.zshrc /home/vscode/.bashrc
