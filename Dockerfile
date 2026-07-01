FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends liblcms2-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY web ./web

ENV PORT=8080 HOST=0.0.0.0
EXPOSE 8080

# Mount your profile and set ICC_PROFILE, e.g.
#   -v ./profiles:/profiles:ro -e ICC_PROFILE=/profiles/CP1500-farbenwerk.icc
CMD ["node", "server/index.js"]
