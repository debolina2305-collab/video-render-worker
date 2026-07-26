FROM node:20-slim

# Puppeteer/Chromium runtime deps + ffmpeg + edge-tts
RUN apt-get update && apt-get install -y \
    ffmpeg python3 python3-pip \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
    libatk1.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 \
    libnspr4 libnss3 libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 \
    libxkbcommon0 libxrandr2 xdg-utils wget \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages edge-tts

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
RUN mkdir -p /tmp/quiz_videos

EXPOSE 3000
CMD ["npm", "start"]
