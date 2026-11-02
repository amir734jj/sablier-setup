FROM node:lts-alpine
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev
COPY server.js .
COPY views ./views
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
  CMD ["wget", "-T", "4", "-O", "/dev/null", "http://127.0.0.1:8080/health"]
CMD ["node", "server.js"]