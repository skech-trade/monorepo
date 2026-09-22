# The signer is a C shared library, so this builds it and then throws the
# toolchain away.
FROM oven/bun:1.4-debian AS native
WORKDIR /build
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc libc6-dev ca-certificates curl python3 \
 && rm -rf /var/lib/apt/lists/*
COPY services/trader/native ./native
# Pulls Lighter's own signer out of their published wheel and compiles the
# shim against it. Nothing Python is installed or run; the wheel is a zip.
RUN chmod +x native/*.sh && ./native/build.sh

FROM oven/bun:1.4-debian AS run
WORKDIR /srv
RUN printf '{"private":true,"workspaces":["services/trader","packages/core"]}' > package.json
COPY services/trader/package.json ./services/trader/package.json
COPY packages/core/package.json ./packages/core/package.json
RUN bun install --production
COPY services/trader/src ./services/trader/src
COPY packages/core/src ./packages/core/src
WORKDIR /srv/services/trader
COPY --from=native /build/native/vendor/lighter-signer-*.so /build/native/vendor/shim.so ./native/vendor/
ENV LIGHTER_SHIM=/srv/services/trader/native/vendor/shim.so
ENV PORT=3220
EXPOSE 3220
USER bun
CMD ["bun", "src/index.ts"]
