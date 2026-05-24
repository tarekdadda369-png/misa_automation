# Render / cloud — official Playwright image (Chromium + OS deps included)
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

RUN npx playwright install chromium

ENV NODE_ENV=production
ENV PRODUCTION_MODE=1
ENV PLAYWRIGHT_HEADLESS=1
ENV PORT=3050
ENV MAX_CONCURRENT_RUNS=1

EXPOSE 3050

CMD ["node", "server.js"]
