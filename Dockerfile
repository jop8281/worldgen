# Build from the repo root: the image needs code/ and prod/worlds/, which sit side by side.
#   docker build -t worldplay .
FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61
WORKDIR /app/code
COPY code/package.json code/bun.lock ./
RUN bun install --frozen-lockfile
COPY code/ ./
COPY prod/worlds/ /worlds/
# `worldplay` on PATH, so the image name plus `serve <dir>` is the whole command line.
RUN printf '#!/bin/sh\nexec bun /app/code/src/cli/worldplay.ts "$@"\n' > /usr/local/bin/worldplay \
    && chmod 755 /usr/local/bin/worldplay
# The world listener binds every interface so the published port reaches it from outside the container.
ENV WORLDPLAY_HOST=0.0.0.0
# Admin stays on container loopback. Publishing 4001 needs `--admin-host 0.0.0.0` on purpose.
ENV WORLDPLAY_ADMIN_HOST=127.0.0.1
USER bun
EXPOSE 4000
# Healthy once the world port answers GET /openapi.json, so `docker run -d` callers can wait for readiness.
# It probes port 4000, the CMD default; a run with another --port stays unhealthy.
HEALTHCHECK --interval=1s --timeout=3s --start-period=2s --retries=30 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:4000/openapi.json').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["worldplay"]
CMD ["serve", "/worlds/helpdesk", "--port", "4000"]
