#!/bin/sh
# ============================================================================
# gitleaks.sh <gitleaks args> - secret scanning at ONE pinned version, for the
# pre-commit hook, CI and a run by hand:
#
#   sh scripts/gitleaks.sh git --pre-commit --staged     (the hook)
#   sh scripts/gitleaks.sh git --log-opts=--all          (CI: every commit)
#
# Scans the repository the CALLER is in, so the hook works from any checkout
# that points core.hooksPath at .githooks. A local gitleaks is used only when
# it is exactly the pinned version; otherwise the official image runs, pinned
# by digest, with no network and the repository mounted read-only. Findings
# are listed (file, line, rule) with the value redacted, so a leaked value
# never reaches a terminal or a CI log.
#
# Version chosen 2026-10-22: 8.30.1, the latest release (gitleaks/gitleaks).
# ============================================================================
set -eu
VERSION=8.30.1
IMAGE=ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f

top=$(git rev-parse --show-toplevel)
if command -v gitleaks >/dev/null 2>&1 && [ "$(gitleaks version 2>/dev/null)" = "$VERSION" ]; then
  cd "$top"
  exec gitleaks "$@" --redact --verbose --no-banner .
fi
exec docker run --rm --network none --user "$(id -u):$(id -g)" \
  -v "$top:/repo:ro" -w /repo "$IMAGE" "$@" --redact --verbose --no-banner /repo
