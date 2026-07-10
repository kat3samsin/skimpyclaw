# Security

SkimpyClaw runs model output, local tools, and authenticated dashboard routes on your machine. A security report needs a private path until a fix ships.

## Report a vulnerability

This repository does not have GitHub private vulnerability reporting or a published security email. Open a [GitHub issue](https://github.com/kat3samsin/skimpyclaw/issues/new) titled `Private security report requested`. Include no exploit, credential, log, or user-data details. The maintainer can arrange a private contact path before you share the report.

The private report should include the affected commit or release, attack path, required access, minimal reproduction, and the files, data, or commands an attacker can reach.

## Supported code

Security fixes land on `trunk`. SkimpyClaw has no formal support window for older releases, so reproduce the issue against the current branch when you can.

## Security boundaries

Reports are useful when they cross one of these boundaries:

- gateway authentication or token handling;
- allowed-path or symlink containment;
- command approval and child-process cleanup;
- SSRF, redirect, or private-network blocking;
- secret storage, redaction, or sanitized child environments;
- channel authorization or agent-profile isolation.

General model behavior, prompt quality, and provider availability belong in the normal issue tracker unless they expose data or execute work without the required authorization.
