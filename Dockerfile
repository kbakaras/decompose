FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force && mkdir /data && chown node:node /data
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
VOLUME /data
CMD ["node", "dist/server/index.js"]
