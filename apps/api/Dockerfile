# syntax=docker/dockerfile:1.28.0@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b
# nwfl-mensa-api image. Stages: builder (compiles TypeScript) -> deps
# (production node_modules) -> production (runtime only).
#
# Base: Node 24 LTS on Debian 13 (trixie) slim, pinned by DIGEST in every stage
# so a retagged upstream image cannot change the runtime under us. Node 24
# matches the fc-shared engines floor (>= 24.15.0) and the CI test runtime.
#
# Runtime contract:
#   - non-root, numeric uid/gid 10001, so a pod can enforce runAsNonRoot;
#   - read-only root filesystem: the process writes nothing to disk (logs go
#     to stdout), so `readOnlyRootFilesystem: true` needs no writable mount;
#   - gRPC (h2c) on 50051, plain-HTTP health on 8081;
#   - dumb-init as PID 1 forwards SIGTERM, so the graceful drain runs.
ARG NODE_IMAGE=node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea

# ============================================================================
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
# fc-shared is a vendored tarball (vendor/README.md), so no registry token is
# needed at build time. --ignore-scripts: no dependency lifecycle scripts run.
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# Readable and searchable by everyone, folders included, before the runtime
# stage copies it (see there).
RUN npm run build && chmod -R u=rwX,go=rX dist

# ============================================================================
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor ./vendor
# --omit=optional: pdf.js's optional canvas (@napi-rs/canvas, about 71 MB) is only for rendering;
# the gate only reads text. Without it pdf.js prints three "Warning: Cannot ..." lines on its first
# load (src/pdf/gate.ts): expected. @cantoo/pdf-lib: Node loads es/ (and dist/standard-fonts, dist/upng),
# never its CommonJS build, sources or UMD bundles.
RUN npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund && npm cache clean --force && cd node_modules/@cantoo/pdf-lib && rm -rf cjs src ts3.4 dist/*.js dist/*.map && cd /app && chmod -R u=rwX,go=rX node_modules

# ============================================================================
FROM ${NODE_IMAGE} AS production

ARG SERVICE_VERSION=0.0.0
# Bump to force the apt layer to rebuild and pick up Debian security fixes.
ARG CACHE_BUST=2026-10-22

LABEL org.opencontainers.image.title="nwfl-mensa-api"
LABEL org.opencontainers.image.description="gRPC API for the NW Florida Mensa website"
LABEL org.opencontainers.image.version="${SERVICE_VERSION}"

# Security patches, dumb-init, the runtime user. npm, npx, corepack and yarn
# are build tools; removing them drops their bundled dependencies (and their
# CVEs) from the runtime.
RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y --no-install-recommends dumb-init && \
    rm -rf /var/lib/apt/lists/* && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg && \
    groupadd -g 10001 nwfl && \
    useradd -u 10001 -g nwfl -M -s /usr/sbin/nologin nwfl

WORKDIR /app
# Owned by root and read-only to the runtime user. The mode is set, not
# inherited: a checkout made under umask 077 leaves files 0600, which the
# runtime user could not read. The build stages set it with chmod, which gives
# every folder its search bit; a symbolic COPY --chmod did not on GitHub's
# runners (dist/auth came out 644).
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --from=builder --chown=root:root /app/dist ./dist
COPY --chown=root:root --chmod=0644 package.json ./

ENV NODE_ENV=production \
    GRPC_PORT=50051 \
    HEALTH_PORT=8081 \
    SERVICE_VERSION=${SERVICE_VERSION}

USER 10001:10001
EXPOSE 50051 8081

# Liveness for Docker/Compose. Kubernetes uses its own probes on 8081.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||8081)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
