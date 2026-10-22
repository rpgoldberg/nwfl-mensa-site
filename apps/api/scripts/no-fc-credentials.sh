#!/bin/sh
# ============================================================================
# no-fc-credentials.sh - fail if any tracked file names the FigureCollecting
# package registry or its token variable (MT-06). This repository's CI never
# holds a FigureCollecting credential; fc-shared is vendored instead.
# The pattern is split so this file does not match itself.
# ============================================================================
set -eu
pattern='NODE_AUTH''_TOKEN|npm[.]pkg[.]github''[.]com'
if git grep -n -I -i -E "$pattern"; then
  echo "no-fc-credentials: FAIL, a FigureCollecting registry or token appears above" >&2
  exit 1
fi
echo "no-fc-credentials: none found"
