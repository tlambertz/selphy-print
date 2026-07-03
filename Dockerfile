# syntax=docker/dockerfile:1
FROM node:24-slim

# tificc (lcms2) is a hard runtime dependency: render.js applies the ICC
# profile with it before encoding. sharp bundles its own libvips, so nothing
# else is needed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends liblcms2-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install prod deps first so this layer caches unless the lockfile changes
# (sharp pulls a prebuilt libvips binary for the platform).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY web ./web

# Run unprivileged; give the built-in `node` user a writable print archive.
RUN mkdir -p /app/print-archive && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0
EXPOSE 8080

# Mount your ICC profile and select it, e.g.
#   -v ./profiles:/profiles:ro -e ICC_PROFILE=/profiles/CP1500-farbenwerk.icc
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
