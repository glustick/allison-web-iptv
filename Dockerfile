# Debian-based ("bookworm-slim"), not Alpine — deliberately. ffmpeg-static's prebuilt binaries
# are linked against glibc, not Alpine's musl libc; running this on an Alpine base is a common,
# easy-to-hit way for the bundled ffmpeg to simply fail to execute at all. See ffmpegResolver.ts
# for the (unrelated) system-ffmpeg-preferred-if-present logic — that would sidestep this too if
# a Synology's own system ffmpeg happens to be on PATH inside the container, but the base image
# choice shouldn't depend on that being true.

FROM node:20-bookworm-slim AS build
WORKDIR /app
# Build tools for better-sqlite3 (the SQLite driver): it ships prebuilt binaries for many
# platforms but not reliably for every Node/arch combination, and without a compiler here
# `npm ci` fails outright with a node-gyp error — the whole image build dies on a dependency
# that the runtime never sees. Build-stage only, so none of this reaches the final image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:client

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV SESSION_SECRET=
# All variable state (accounts, encrypted IPTV credentials) lives here — see the
# docker-compose.yml volume mapping (`./appdata:/appdata:rw`) that keeps it across updates.
ENV DATA_DIR=/appdata
# Reuses the build stage's own node_modules wholesale (including devDependencies) rather than a
# second `npm ci --omit=dev` here — deliberately: a second install would re-trigger
# ffmpeg-static's own binary download a second time, which on a network that needs
# NODE_EXTRA_CA_CERTS (see the README) would mean passing that through to two separate install
# steps instead of one. The extra size from carrying devDependencies (TypeScript, eslint,
# vitest — none of it runs at container runtime) is a reasonable tradeoff for a personal
# self-hosted image; not worth the complexity of a proper prune for this project's scope.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY package.json ./

# Debian's own ffmpeg, installed deliberately. The bundled ffmpeg-static binary for Linux is a
# *static glibc* build, and static glibc binaries cannot use NSS — so they fail to resolve ANY
# hostname at runtime ("Failed to resolve hostname ... System error"), which silently breaks
# transcoding for every network source (the fallback used when a stream's audio (E-AC-3/AC-3)
# or video (HEVC) codec can't be played directly by the browser — confirmed live on a real
# provider). ffmpegResolver already prefers a working system ffmpeg over the bundled copy, so
# installing this is all that's needed. Costs ~400MB of image size.
# gosu rides along for the entrypoint's drop-privileges path (see docker-entrypoint.sh): it is a
# few hundred KB and the alternative — `su`/`runuser` — drags in a whole login stack and mangles
# signal delivery, which matters here because SIGTERM is how the server stops live transcodes on
# shutdown. ffmpeg is the real payload of this layer.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg gosu \
  && rm -rf /var/lib/apt/lists/*

# Both writable locations, created here and owned by the unprivileged user, so a *named* volume
# picks up working ownership straight from the image. A host bind mount still arrives owned by
# whoever created it on the host — see the README's hardening notes for the one-line chown.
RUN mkdir -p /appdata /transcode && chown node:node /appdata /transcode

EXPOSE 8085

# Hits the server's own /api/health (public app, no auth) via Node's built-in fetch rather than
# installing curl/wget into the image just for this — bookworm-slim doesn't ship either. Reads
# PORT the same way src/server/index.ts itself does, so this still works if it's overridden.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8085)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The server itself runs unprivileged. It never needs root: it reads /app, writes its own
# database under /appdata, and writes transcode segments under TRANSCODE_TMP_DIR. The entrypoint
# exists only for the case where a manager starts the container as root anyway, where it fixes
# ownership once and then drops to this same user.
USER node

COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/server/index.js"]
