class Skimpyclaw < Formula
  desc "Lightweight personal AI assistant with Telegram and Discord integration"
  homepage "https://github.com/kat3samsin/skimpyclaw"
  url "https://github.com/kat3samsin/skimpyclaw/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "PLACEHOLDER_SHA256"
  license "MIT"

  depends_on "node"
  depends_on "pnpm"

  def install
    system "pnpm", "install", "--frozen-lockfile"
    system "pnpm", "run", "build"
    
    # Install compiled JS and templates
    libexec.install "dist", "templates", "package.json"
    
    # Create wrapper script
    (bin/"skimpyclaw").write <<~EOS
      #!/bin/bash
      export SKIMPYCLAW_HOME="${HOME}/.skimpyclaw"
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/dist/cli.js" "$@"
    EOS
    chmod 0755, bin/"skimpyclaw"
  end

  def post_install
    ohai "SkimpyClaw installed!"
    ohai "Run 'skimpyclaw onboard' to configure"
  end

  test do
    system "#{bin}/skimpyclaw", "--version"
  end
end
