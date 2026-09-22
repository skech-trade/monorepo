FROM oven/bun:1.4-alpine AS base
WORKDIR /srv
# The API scores predictions with the shared core package.
RUN printf '{"private":true,"workspaces":["services/api","packages/core"]}' > package.json
COPY services/api/package.json ./services/api/package.json
COPY packages/core/package.json ./packages/core/package.json
RUN bun install --production
COPY packages/core/src ./packages/core/src
COPY services/api/src ./services/api/src
WORKDIR /srv/services/api
ENV PORT=3230
EXPOSE 3230
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "const r=await fetch('http://127.0.0.1:'+(process.env.PORT??3230)+'/health');const d=await r.json();process.exit(d.ok?0:1)"
USER bun
CMD ["bun", "src/index.ts"]
