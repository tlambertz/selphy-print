# syntax=docker/dockerfile:1

# ── Stage 1: build the Android companion APK ───────────────────────────────
# Heavy (pulls the Android SDK), but multi-stage: none of the toolchain lands
# in the runtime image — only the finished APK is copied out. gradle 8.7 / JDK
# 17 match the app's AGP 8.5 / compileSdk 35.
FROM gradle:8.7-jdk17 AS apk
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH="$PATH:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin"
RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/cmdtools.zip \
      https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
 && mkdir -p "$ANDROID_SDK_ROOT/cmdline-tools" \
 && unzip -q /tmp/cmdtools.zip -d "$ANDROID_SDK_ROOT/cmdline-tools" \
 && mv "$ANDROID_SDK_ROOT/cmdline-tools/cmdline-tools" "$ANDROID_SDK_ROOT/cmdline-tools/latest" \
 && rm /tmp/cmdtools.zip \
 && yes | sdkmanager --licenses > /dev/null \
 && sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0" > /dev/null
WORKDIR /build
COPY android ./android
# assembleRelease auto-generates a self-signed keystore (keytool ships in the JDK).
RUN cd android && gradle --no-daemon assembleRelease

# ── Stage 2: fetch the free ICC profiles ───────────────────────────────────
FROM debian:stable-slim AS profiles
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /p
COPY scripts/fetch-profile.sh ./scripts/fetch-profile.sh
# Writes ./profiles (warns-but-continues if a profile host is down).
RUN bash scripts/fetch-profile.sh

# ── Stage 3: runtime image ─────────────────────────────────────────────────
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

# Baked in from the build stages: the freshly-built companion APK and the
# fetched ICC profiles (auto-discovered from ./profiles — no runtime mount
# needed; drop more *.icc in there or override ICC_DIR to add your own).
COPY --from=apk /build/android/app/build/outputs/apk/release/*.apk ./web/selphy-share.apk
COPY --from=profiles /p/profiles ./profiles

# Run unprivileged; give the built-in `node` user a writable print archive.
RUN mkdir -p /app/print-archive && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0
EXPOSE 8080

# Set PRINTER_HOST to your CP1500's IP (or CP1500xxxxxx.local with host
# networking). The bundled profiles are selectable per photo in the app.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
