FROM node:lts-alpine
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev
COPY server.mjs events.mjs ./
EXPOSE 2375
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
  CMD ["wget", "-T", "4", "-O", "/dev/null", "http://127.0.0.1:2375/containers/json"]
CMD ["node", "server.mjs"]
