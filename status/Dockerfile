FROM node:lts-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:lts-alpine
WORKDIR /app
COPY --from=build /app ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
  CMD ["wget", "-T", "4", "-O", "/dev/null", "http://127.0.0.1:8080/health"]
CMD ["node", "server.js"]