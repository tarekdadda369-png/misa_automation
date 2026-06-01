FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

RUN npx playwright install chromium

ENV NODE_ENV=production
ENV PLAYWRIGHT_HEADLESS=0
ENV PORT=3050
ENV MAX_CONCURRENT_RUNS=3

EXPOSE 3050

CMD xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" node server.js
