# Debian-based ("bookworm-slim"), not Alpine — deliberately. ffmpeg-static's prebuilt binaries
# are linked against glibc, not Alpine's musl libc; running this on an Alpine base is a common,
# easy-to-hit way for the bundled ffmpeg to simply fail to execute at all. See ffmpegResolver.ts
# for the (unrelated) system-ffmpeg-preferred-if-present logic — that would sidestep this too if
# a Synology's own system ffmpeg happens to be on PATH inside the container, but the base image
# choice shouldn't depend on that being true.

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:client

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
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

EXPOSE 8085

# Hits the server's own /api/health (public app, no auth) via Node's built-in fetch rather than
# installing curl/wget into the image just for this — bookworm-slim doesn't ship either. Reads
# PORT the same way src/server/index.ts itself does, so this still works if it's overridden.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8085)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
