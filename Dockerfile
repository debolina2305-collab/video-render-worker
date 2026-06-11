FROM node:20-slim

RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip && rm -rf /var/lib/apt/lists/*
RUN pip3 install edge-tts
RUN npm install -g puppeteer

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

RUN mkdir -p /tmp/quiz_videos
EXPOSE 3000
CMD ["npm", "start"]
