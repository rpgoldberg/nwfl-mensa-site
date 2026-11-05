# syntax=docker/dockerfile:1.28.0@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b
# nwfl-mensa-linkcheck image: the off-cluster link checker (README). It runs only on the officer's own
# machine, never in a cluster, as two separate containers from this one image (scripts/linkcheck.sh):
#   extract  --network none: reads the PDF's links; the only part that parses a PDF;
#   check    a network but no PDF: checks each link, SSRF-guarded (src/net.ts).
# Stages: builder (compiles TypeScript) -> deps (production node_modules) -> production (runtime only).
# The same digest-pinned Node 24 LTS and Debian 13 slim bases as apps/api, node copied in alone, so npm
# and its dependencies stay out of the runtime.
#
# Runtime contract: uid/gid 65534 (nobody), a read-only root filesystem (only the mounted output folder
# and a tmpfs /tmp are written), no capabilities. The command is the subcommand and its arguments.
ARG NODE_IMAGE=node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea
ARG DEBIAN_IMAGE=debian:13.7-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4

# ============================================================================
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && chmod -R u=rwX,go=rX dist

# ============================================================================
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --omit=optional: pdf.js's optional canvas is only for rendering; extract reads annotations and text.
RUN npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund && npm cache clean --force && chmod -R u=rwX,go=rX node_modules

# ============================================================================
FROM ${DEBIAN_IMAGE} AS production

ARG SERVICE_VERSION=0.0.0
# Bump to force the apt layer to rebuild and pick up Debian security fixes.
ARG CACHE_BUST=2026-11-04

LABEL org.opencontainers.image.title="nwfl-mensa-linkcheck"
LABEL org.opencontainers.image.description="Off-cluster link checker for the NW Florida Mensa newsletter"
LABEL org.opencontainers.image.version="${SERVICE_VERSION}"

# ca-certificates is not needed: node carries its own CA store, which the check uses.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

COPY --from=deps --chown=root:root --chmod=0755 /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --from=builder --chown=root:root /app/dist ./dist
COPY --chown=root:root --chmod=0644 package.json ./

ARG REVISION
LABEL org.opencontainers.image.revision="${REVISION:?pass the full commit sha as --build-arg REVISION}"
LABEL org.opencontainers.image.source="https://github.com/rpgoldberg/nwfl-mensa-site"

ENV NODE_ENV=production \
    SERVICE_VERSION=${SERVICE_VERSION}

USER 65534:65534

ENTRYPOINT ["node", "dist/bin.js"]
CMD ["help"]
