#!/bin/bash
set -e

# SkimpyClaw Installer Script
# Usage: curl -fsSL https://raw.githubusercontent.com/kat3samsin/skimpyclaw/main/install.sh | bash

REPO="kat3samsin/skimpyclaw"
INSTALL_DIR="/usr/local/bin"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🦞 Installing SkimpyClaw..."

# Detect OS and architecture
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$ARCH" in
    x86_64) ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *) echo -e "${RED}Unsupported architecture: $ARCH${NC}"; exit 1 ;;
esac

case "$OS" in
    linux|darwin) ;;  # Supported
    *) echo -e "${RED}Unsupported OS: $OS${NC}"; exit 1 ;;
esac

# Get latest release
LATEST=$(curl -s "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')

if [ -z "$LATEST" ]; then
    echo -e "${RED}Failed to fetch latest release${NC}"
    exit 1
fi

echo "📦 Latest version: $LATEST"

# Download URL
FILENAME="skimpyclaw-$OS-$ARCH.tar.gz"
URL="https://github.com/$REPO/releases/download/$LATEST/$FILENAME"

# Create temp directory
TMP_DIR=$(mktemp -d)
trap "rm -rf $TMP_DIR" EXIT

echo "⬇️  Downloading from $URL..."
curl -fsSL "$URL" -o "$TMP_DIR/$FILENAME" || {
    echo -e "${RED}Download failed${NC}"
    exit 1
}

# Extract
echo "📂 Extracting..."
tar -xzf "$TMP_DIR/$FILENAME" -C "$TMP_DIR"

# Install binary
echo "🚀 Installing to $INSTALL_DIR..."
if [ -w "$INSTALL_DIR" ]; then
    mv "$TMP_DIR/skimpyclaw" "$INSTALL_DIR/"
else
    sudo mv "$TMP_DIR/skimpyclaw" "$INSTALL_DIR/"
fi

# Make executable
chmod +x "$INSTALL_DIR/skimpyclaw"

echo -e "${GREEN}✅ SkimpyClaw installed successfully!${NC}"
echo ""
echo "Run 'skimpyclaw onboard' to get started"
