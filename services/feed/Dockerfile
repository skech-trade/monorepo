# The feed needs nothing but Bun and a socket to the venue.
FROM oven/bun:1.4-alpine AS base
WORKDIR /srv
COPY package.json ./
COPY src ./src
ENV PORT=3210
EXPOSE 3210
# Alpine's shell has no curl by default, so the check uses Bun itself.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "const r=await fetch('http://127.0.0.1:'+(process.env.PORT??3210)+'/health');const d=await r.json();process.exit(d.ok?0:1)"
USER bun
CMD ["bun", "src/index.ts"]
