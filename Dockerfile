# Playwright's official image already has Chromium and every system library it needs.
# The tag must match the playwright-core version in package.json.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

# QEMU runs the Android phone (see android.js)
RUN apt-get update && apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY . .
ENV NODE_ENV=production
CMD ["node", "server.js"]
