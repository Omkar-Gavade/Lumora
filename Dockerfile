# The backend image — one artifact, two roles (docs/09 §5.1).
#
# The API and the worker share their entire dependency tree and codebase and
# differ only in entrypoint. Two images would double build time, registry
# storage, and scan surface to express a one-word difference, and would let the
# two halves drift onto different code — a genuinely bad failure mode for a
# queue where one side writes rows the other reads.
#
# Built from the repository root, not from `backend/`: this is an npm workspace
# and the backend depends on `@lumora/shared`, which lives outside that
# directory. A build context rooted at `backend/` cannot see it.

# ── Build stage ───────────────────────────────────────────────────────────────
#
# Debian slim rather than Alpine, and this was verified rather than assumed.
# `argon2` and `pdfjs-dist` are the risk: argon2 ships prebuilt binaries per
# libc, and a musl mismatch surfaces as a runtime crash on the first login
# rather than a build failure. Slim costs roughly 40MB over Alpine and removes
# an entire class of "works in CI, segfaults in production".
FROM node:22-slim AS build

WORKDIR /app

# Manifests first, so a source edit does not invalidate the dependency layer.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

# `npm ci` from the committed lockfile — never `npm install`, which may resolve
# something the lockfile does not describe. `--ignore-scripts` is deliberately
# NOT set: argon2's install script is what fetches its prebuilt binary.
# Plain `npm ci` at the workspace root. `--workspaces` scopes the command to
# the members and does NOT create the root `node_modules/@lumora/*` symlinks
# the backend resolves `@lumora/shared` through — the build then fails with
# "Cannot find module" after an install that reported success.
RUN npm ci

COPY shared/ ./shared/
COPY backend/ ./backend/

# `shared` first: the backend imports its build output, not its source.
RUN npm run build --workspace @lumora/shared \
 && npm run build --workspace @lumora/backend

# Re-resolve with production dependencies only. Done as a separate step rather
# than by pruning, so the result is exactly what the lockfile says a production
# install contains.
RUN npm ci --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

ENV NODE_ENV=production

# 0.0.0.0, not the 127.0.0.1 default. `backend/.env.example` says why: inside a
# container the loopback default publishes the port to nothing.
ENV HOST=0.0.0.0
ENV PORT=4000

WORKDIR /app

# Only what runs. No source, no tests, no docs, no `.env` — `.dockerignore`
# excludes those from the context entirely, so they cannot arrive by accident.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/shared/package.json ./shared/
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/package.json ./backend/

# The pinned Supabase root CA. Without it the container starts, connects to
# nothing, and dies on the first query with `self-signed certificate in
# certificate chain` — `config/database.ts` reads this file at module load.
COPY --from=build /app/backend/certs ./backend/certs
COPY --from=build /app/package.json ./

# The image ships its own migrations: `backend/scripts/copy-assets.mjs` copies
# `src/db/migrations` into `dist`, which is what lets the migration task run
# from this same image rather than from a checkout (docs/09 §13.1).

# The `node` user ships with the image. Running as root buys nothing here — the
# process binds a high port and writes only to /tmp.
USER node

EXPOSE 4000

# No HEALTHCHECK: the orchestrator probes `/health` (liveness) and
# `/health/ready` (readiness, which checks the database). A second definition
# inside the image is one more place for the two to disagree.

# Node is PID 1 and already installs SIGTERM and SIGINT handlers with a
# re-entry guard and an unref'ed timeout, draining the worker after the HTTP
# server closes — so there is nothing for `tini` to forward.
#
# The API is the default. The worker overrides this with
# `["node", "backend/dist/worker.js"]` in its task definition.
CMD ["node", "backend/dist/server.js"]
