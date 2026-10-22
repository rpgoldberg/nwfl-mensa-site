#!/bin/sh
# ============================================================================
# no-fc-credentials.sh - fail if any tracked file of the repository names the
# FigureCollecting package registry or its token variable (MT-06). The
# repository's CI never holds a FigureCollecting credential; fc-shared is
# vendored instead. It searches from the top of the repository whichever folder
# it runs from (git grep alone would search only the folder it runs in).
# The pattern is split so this file does not match itself.
# ============================================================================
set -eu
cd "$(git rev-parse --show-toplevel)"
pattern='NODE_AUTH''_TOKEN|npm[.]pkg[.]github''[.]com'
if git grep -n -I -i -E "$pattern"; then
  echo "no-fc-credentials: FAIL, a FigureCollecting registry or token appears above" >&2
  exit 1
fi
echo "no-fc-credentials: none found"
