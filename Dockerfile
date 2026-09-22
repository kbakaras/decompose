FROM node:24-bookworm-slim AS build
WORKDIR /app
ARG APP_VERSION=local
ENV VITE_APP_VERSION=$APP_VERSION
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ARG APP_VERSION=local
ARG SOURCE_URL=https://github.com/kbakaras/decompose
ARG VCS_REF=unknown
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data
LABEL org.opencontainers.image.title="Decompose" \
      org.opencontainers.image.description="Keyboard-first collaborative editor for decomposing complex tasks into structured trees." \
      org.opencontainers.image.source=$SOURCE_URL \
      org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.licenses="Apache-2.0"
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force && mkdir /data && chown node:node /data
COPY LICENSE NOTICE THIRD_PARTY_NOTICES ./
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
VOLUME /data
CMD ["node", "dist/server/index.js"]
