# syntax=docker/dockerfile:1

FROM node:20-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-slim
WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/db/migrations ./db/migrations

ENV NODE_ENV=production
ENV BIOFLOW_RUNNER_MODE=inline
ENV BIOFLOW_SERVICE_DATA_DIR=/data
EXPOSE 8080

RUN mkdir -p /data && chown -R node:node /data
USER node

CMD ["npm", "run", "start"]
