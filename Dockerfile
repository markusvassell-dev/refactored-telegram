# Element Engagements — one image, two entrypoints.
#
# The web and worker services run the same image with different commands. The
# worker needs headless LibreOffice for DOCX-to-PDF conversion, and the web
# service needs it too when a reviewer regenerates a preview, so both share it.

FROM node:22-bookworm-slim AS base

ENV PNPM_HOME=/usr/local/bin \
    NODE_OPTIONS=--max-old-space-size=1536 \
    NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_HOME=/opt/corepack

# COREPACK_HOME is set to a shared path deliberately. Its default is inside the
# invoking user's home directory, so a pnpm prepared here as root would be
# invisible to the unprivileged runtime user, and corepack would try to download
# pnpm from the network on every container start — a slow boot that fails
# outright on a locked-down network.
RUN corepack enable \
 && corepack prepare pnpm@9.15.4 --activate \
 && chmod -R a+rX "$COREPACK_HOME"

WORKDIR /app


# ---------------------------------------------------------------------------
# Dependencies. Cached separately from the source so a code change does not
# reinstall the world.
# ---------------------------------------------------------------------------
FROM base AS deps

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json                 apps/web/
COPY apps/worker/package.json              apps/worker/
COPY packages/shared/package.json          packages/shared/
COPY packages/database/package.json        packages/database/
COPY packages/documents/package.json       packages/documents/
COPY packages/integrations/package.json    packages/integrations/
COPY packages/services/package.json        packages/services/
COPY packages/workflows/package.json       packages/workflows/
COPY packages/pricing/package.json         packages/pricing/
COPY packages/dates/package.json           packages/dates/
COPY packages/audit/package.json           packages/audit/
COPY packages/ui/package.json              packages/ui/

RUN pnpm install --frozen-lockfile


# ---------------------------------------------------------------------------
# Build the Next.js application.
# ---------------------------------------------------------------------------
FROM deps AS builder

COPY . .

RUN pnpm db:generate

# APP_ENV=development keeps the environment schema satisfiable at build time.
# These values are build-time placeholders only; nothing secret is baked in and
# every one is replaced by the real environment at run time.
RUN APP_ENV=development \
    DATABASE_URL="postgresql://build:build@localhost:5432/build" \
    ENCRYPTION_KEY="0000000000000000000000000000000000000000000000000000000000000000" \
    SESSION_SECRET="0000000000000000000000000000000000000000000000000000000000000000" \
    pnpm build


# ---------------------------------------------------------------------------
# Runtime.
# ---------------------------------------------------------------------------
FROM base AS runtime

# libreoffice-writer is what actually converts .docx; libreoffice-core alone
# cannot load the format. The fonts keep the rendered PDF faithful to Word.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openssl \
      ca-certificates \
      libreoffice-writer \
      libreoffice-core \
      fonts-liberation \
      fonts-dejavu-core \
      fontconfig \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f

ENV APP_ENV=production \
    NODE_ENV=production \
    LIBREOFFICE_BINARY=/usr/bin/soffice \
    DOCUMENT_TEMP_DIRECTORY=/tmp/element-engagements \
    DOCUMENT_STORAGE_DIRECTORY=/var/lib/element-engagements/storage

COPY --from=builder /app /app

# Working copies of client documents live here; the volume is not world
# readable and the retention job purges it.
RUN mkdir -p "$DOCUMENT_TEMP_DIRECTORY" "$DOCUMENT_STORAGE_DIRECTORY" \
 && chmod 700 "$DOCUMENT_TEMP_DIRECTORY" "$DOCUMENT_STORAGE_DIRECTORY" \
 && useradd --system --uid 10001 --home /app element \
 && chown -R element:element /app "$DOCUMENT_TEMP_DIRECTORY" "$DOCUMENT_STORAGE_DIRECTORY"

RUN chmod +x /app/scripts/start.sh /app/scripts/start-web.sh /app/scripts/start-worker.sh

USER element

# One port, deliberately. Railway infers the port it will health-check from the
# image when PORT is not set, and two exposed ports make that a coin toss — the
# web service gets probed on 3001, the worker on 3000, and both deployments are
# marked unhealthy while both processes are running. Each service listens on
# whatever PORT it is given; see scripts/start-*.sh.
EXPOSE 3000

# One command for both services. Which one this container becomes is decided by
# SERVICE_ROLE in its own variables, not by a per-service override that fails
# silently when it is forgotten.
CMD ["./scripts/start.sh"]
