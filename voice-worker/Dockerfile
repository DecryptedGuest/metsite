# voice-worker/Dockerfile — the Fly.io image for the MET CAD voice worker.
FROM node:20-slim

# ffmpeg-static ships its own binary, so no apt ffmpeg is needed. We keep the
# image slim; native voice deps (opus/libsodium) build from prebuilt wheels.
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Fly health-checks /health on this port (see fly.toml).
ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.js"]
