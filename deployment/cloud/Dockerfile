FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/package.json
COPY integration/package.json ./integration/package.json
RUN npm ci --omit=dev --ignore-scripts --workspace integration --include-workspace-root
COPY integration ./integration
COPY src/backend ./src/backend
COPY deployment ./deployment
RUN install -d -m 0700 -o node -g node /app/.integration-state
ENV NODE_ENV=production INTEGRATION_PORT=4350 NODE_RELAY_PORT=4351 NODE_RELAY_HOST=0.0.0.0 INTEGRATION_STATE_DIR=/app/.integration-state
USER node
EXPOSE 4351
CMD ["node", "deployment/start.mjs"]
