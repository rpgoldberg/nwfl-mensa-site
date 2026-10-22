#!/bin/sh
# ============================================================================
# buf-breaking.sh <base> - buf breaking against a base commit, run from the
# API's folder (apps/api in the repository).
#
# A base with no buf.yaml has no module to break, which is the case for the
# first proto commit; that is a loud skip, not a pass by accident. Any other
# base is compared with the FILE rule set from buf.yaml.
# ============================================================================
set -eu
base=${1:?usage: buf-breaking.sh <base-commit>}
# The module is this folder, apps/api in the repository: the base is read there.
prefix=$(git rev-parse --show-prefix)
if ! git cat-file -e "$base:${prefix}buf.yaml" 2>/dev/null; then
  echo "buf-breaking: SKIP, $base has no ${prefix}buf.yaml (no module to compare against)"
  exit 0
fi
exec npx --no-install buf breaking --against "$(git rev-parse --show-toplevel)/.git#ref=$base,subdir=${prefix%/}"
