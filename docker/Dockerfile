# syntax=docker/dockerfile:1
# Production image: API server + built editor. Same image runs locally and in the cloud.

FROM node:24-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
# Only what the server and editor need (skips Electron for the desktop app).
RUN pnpm install --frozen-lockfile --filter "@app/server..." --filter "@app/editor..."
RUN pnpm turbo run build --filter=@app/server --filter=@app/editor
RUN pnpm --filter @app/server deploy --prod --legacy /out/server \
  && cp -r packages/editor/dist /out/editor

FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    PORT=5680 \
    EDITOR_DIST_PATH=/app/editor
WORKDIR /app
COPY --from=build --chown=node:node /out/server ./server
COPY --from=build --chown=node:node /out/editor ./editor
USER node
EXPOSE 5680
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz/readiness').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/main.js"]
