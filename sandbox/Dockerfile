FROM node:22-slim

ARG SKIMPY_PROFILE=minimal

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    gnupg \
    jq \
    python3 \
    ripgrep \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && if [ "$SKIMPY_PROFILE" = "dev" ] || [ "$SKIMPY_PROFILE" = "full" ]; then \
      apt-get install -y --no-install-recommends build-essential make gcc g++ pkg-config; \
    fi \
  && if [ "$SKIMPY_PROFILE" = "full" ]; then \
      apt-get install -y --no-install-recommends python3-pip sqlite3 unzip less; \
    fi \
  && rm -rf /var/lib/apt/lists/*

# Install pnpm globally (Claude Code not needed inside sandbox)
RUN npm install -g pnpm

# Create non-root user matching typical macOS uid/gid
RUN groupadd -g 20 sandboxgrp || true \
  && useradd -m -s /bin/bash -u 501 -g 20 sandbox || true

USER sandbox
WORKDIR /workspace

CMD ["sleep", "infinity"]
