FROM mcr.microsoft.com/playwright:v1.49.1-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PROMID_HEADLESS=true
ENV PROMID_LOGIN_STATE_PATH=/app/.auth/promid-state.json

CMD ["npm", "start"]
