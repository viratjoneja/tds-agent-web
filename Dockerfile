# TDS / TCS Return Builder - container for Google Cloud Run (office portal, served at /tds)
# ---- build: install, run the engine tests, build the app ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm test && npm run build

# ---- run: the server has no dependencies beyond Node ----
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=build /app/dist ./dist
COPY --from=build /app/server.mjs /app/auth.mjs /app/package.json ./
COPY --from=build /app/src/app/firebase-config.json ./src/app/firebase-config.json
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
