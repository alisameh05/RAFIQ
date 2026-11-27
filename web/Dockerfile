FROM node:24.22.3-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm install --global npm@11.19.1 && npm ci
COPY app ./app
COPY public ./public
COPY tests ./tests
COPY playwright.config.ts tsconfig.json proxy.ts ./
RUN npm run build && npm run typecheck
USER node
ENV NODE_ENV=production
CMD ["npm", "start", "--", "--hostname", "0.0.0.0"]
