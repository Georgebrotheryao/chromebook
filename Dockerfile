# Playwright's official image already has Chromium and every system library it needs.
# The tag must match the playwright-core version in package.json.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY . .
ENV NODE_ENV=production
CMD ["node", "server.js"]
