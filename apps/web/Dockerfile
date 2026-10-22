# syntax=docker/dockerfile:1
# nwfl-mensa-web image: the Astro server (the site's web gateway) behind the
# site policy in server/. Stages: build (astro build) -> deps (production
# node_modules) -> production (runtime only).
#
# Base: Node 24 LTS on Debian 13 (trixie) slim, pinned by DIGEST in every stage,
# the same base as nwfl-mensa-api.
#
# Runtime contract:
#   - non-root, numeric uid/gid 10001, so a pod can enforce runAsNonRoot;
#   - read-only root filesystem: the server writes nothing to disk (logs go to
#     stdout, Astro sessions are off); mount /tmp writable, nothing else;
#   - HTTP on 8080, with /healthz for probes;
#   - dumb-init as PID 1 forwards SIGTERM, so the drain in server/start.mjs runs.
ARG NODE_IMAGE=node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea

# ============================================================================
FROM ${NODE_IMAGE} AS build
WORKDIR /app
# --ignore-scripts: no dependency lifecycle scripts run.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY astro.config.mjs tsconfig.json ./
COPY public ./public
COPY src ./src
COPY content ./content
# The layout imports server/prefs.mjs, so the server code is in place for the build.
COPY server ./server
# --build-arg PUBLIC_ONLY=true makes the public-only canary image: no sign-in at all.
ARG PUBLIC_ONLY=false
RUN PUBLIC_ONLY=${PUBLIC_ONLY} npx astro build
# Readable to the runtime user whatever mode the checkout gave the sources.
RUN chmod -R a+rX dist server

# ============================================================================
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

# ============================================================================
FROM ${NODE_IMAGE} AS production

ARG SERVICE_VERSION=0.0.0
# Bump to force the apt layer to rebuild and pick up Debian security fixes.
ARG CACHE_BUST=2026-10-22

LABEL org.opencontainers.image.title="nwfl-mensa-web"
LABEL org.opencontainers.image.description="Web gateway for the NW Florida Mensa website"
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
# Owned by root and read-only to the runtime user.
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --from=build --chown=root:root /app/server ./server
COPY --chown=root:root --chmod=0644 package.json ./

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    SERVICE_VERSION=${SERVICE_VERSION}

USER 10001:10001
EXPOSE 8080

# Liveness for Docker/Compose. Kubernetes uses its own probes on /healthz.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server/serve.mjs"]
