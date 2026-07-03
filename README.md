# selphy-print

A self-hosted PWA that prints photos to a **Canon SELPHY CP1500** over WiFi with
proper ICC color management. Install it on Android, share photos to it from your
gallery (single or bulk), crop them to the printer's real geometry, and print.

```
Android share sheet ──► PWA (crop UI, queue) ──► Node server ──► ICC convert ──► CPNP ──► CP1500
```

## Why this exists

- **The "borders thing":** borderless on the CP1500 is genuinely hard. The
  print head images a canvas *larger* than the paper — 1248×1872 px
  (105.7×158.5 mm; Gutenprint `print-dyesub.c`) versus the 100×148 mm postcard —
  and the firmware unconditionally enlarges every borderless job onto it, so
  the outer few mm never land on paper. Over standard IPP you can't tame that.
  Measured on a real CP1500 (fw 1.0.6.0), the hard way:

  - **JPEG over IPP is a firmware black box.** `print-scaling` is advertised
    but absent from `job-creation-attributes-supported` and provably ignored;
    page-size, canvas-size and oversize JPEGs all printed with identical
    placement — 1:1-ish with **white bars at the short ends** — regardless of
    the borderless `media-col`.
  - **PWG raster is rejected** by the CP1500 and **URF prints bordered** — both
    are experiments-only dead ends here.
  - **CPNP is the path that works.** This is Canon's own protocol (what SELPHY
    Photo Layout speaks; reverse-engineered in
    [`docs/cpnp-protocol.md`](docs/cpnp-protocol.md)). The firmware
    aspect-**fill**-scales the JPEG onto the full 1248×1872 head canvas and
    centers it on the sheet — true overscan borderless — and it's the **only**
    transport that can invoke the printer's own Auto Image Correction. It also
    reports per-pass progress, decoded errors, and paper-out pause/resume.

  So the app defaults to CPNP (`PRINT_FORMAT=cpnp`) and renders your crop at
  **exactly** the 1248×1872 head canvas, making the firmware's scale factor
  1.0 — deterministic geometry with no printer-side rescale guesswork. The
  structural canvas overhang (≈5 mm per short end, less on the long sides) is
  bleed that always runs off the paper or onto the tear-off stubs; the crop UI
  visualizes it and **pre-compensates the small measured per-edge trim** from
  calibration. Net result: the frame you set in the crop UI is what lands on
  paper, edge to edge, within the printer's ~±1 mm mechanical feed tolerance
  (shown as a thin guide line). Calibrate once per unit with the in-app
  **calibration page** (mm rulers + T/B/L/R letters, printed deliberately
  *without* compensation so it measures raw firmware behavior). Opposite edges
  genuinely differ (~1–2 mm feed offset), hence per-edge values.
- **Color:** the CP1500 has a fixed internal color pipeline that cannot be
  disabled and tends to oversaturate with a bluish cast. Each photo gets a
  **color mode** (chosen per-image in the crop editor): convert into a printer
  **ICC profile** that characterizes that whole pipeline (accurate color),
  hand color to the printer's own **firmware auto-correct** (Canon's "color
  correct", CPNP-only), or **off** (raw sRGB). Multiple profiles can be
  installed and switched between, with an optional per-photo brightness curve,
  and a no-paper **Preview** that renders the exact bytes the printer will get.

## Quick start (dev)

```bash
npm install
npm run fetch-profile          # downloads the free farbenwerk CP1500 profile
PRINTER_HOST=192.168.1.42 ICC_PROFILE=$PWD/profiles/CP1500-farbenwerk.icc npm start
# open http://localhost:8080
```

Needs `tificc` (from `liblcms2-utils`) on `PATH` for ICC conversion — the
Docker image and Nix package bundle it; for local dev, install it (Debian:
`apt install liblcms2-utils`).

## Deploying

The app must be served over **HTTPS with a browser-trusted certificate**,
otherwise Android will not install the PWA and the share-sheet integration
(`share_target`) will not register. Point your reverse proxy at the server's
plain-HTTP port. No special headers needed; allow request bodies up to ~64 MB
for bulk shares (nginx: `client_max_body_size 64m;`).

### Docker

The image is self-contained — nothing to mount to get started:
`liblcms2-utils` (for `tificc`), the two free ICC profiles (fetched at build
time), and the companion APK (compiled in a build stage) are all baked in, and
`sharp` ships its own libvips. Multi-stage keeps the *runtime* image small; the
build itself is heavier, since one stage pulls the Android SDK to compile the
APK.

```bash
# set PRINTER_HOST in docker-compose.yml, then:
docker compose up -d --build
```

Or without compose:

```bash
docker build -t selphy-print .
docker run -d --name selphy-print -p 8080:8080 \
  -e PRINTER_HOST=192.168.1.42 \
  -v "$PWD/print-archive:/app/print-archive" \
  selphy-print
```

The image runs as the non-root `node` user with a `HEALTHCHECK` on `/api/config`.
The bundled profiles are auto-discovered and selectable per photo; to add your
own, mount a dir of `*.icc` at `/app/profiles` (or set `ICC_DIR`). Bind-mount
`/app/print-archive` to keep a copy of every print. To reach the printer by its
`CP1500xxxxxx.local` mDNS name instead of an IP, add `network_mode: host`
(bridged networking can't resolve `.local`).

### HTTPS via Cloudflare Tunnel

The PWA needs HTTPS with a browser-trusted cert. The easiest way — no open
ports, no cert management — is a **Cloudflare Tunnel**, run on the host **next
to** the container (not inside it) so it can reach `localhost:8080`. It needs a
domain on Cloudflare and `cloudflared` installed:

```bash
cloudflared tunnel login                       # one-time browser auth
cloudflared tunnel create selphy
cloudflared tunnel route dns selphy selphy.example.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: selphy
credentials-file: /root/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: selphy.example.com
    service: http://localhost:8080     # the selphy-print container's mapped port
  - service: http_status:404
```

```bash
cloudflared tunnel run selphy          # or install as a service:
sudo cloudflared service install
```

`https://selphy.example.com` now serves the app with a real cert — open it on
your phone and install. (For a throwaway URL with zero setup,
`cloudflared tunnel --url http://localhost:8080` prints a random
`*.trycloudflare.com` HTTPS address, but it changes on every run.)

Any other HTTPS reverse proxy (Caddy, nginx + Let's Encrypt, Tailscale Funnel)
works too — just forward to the server's plain-HTTP port and allow ~64 MB
bodies for bulk shares.

### NixOS (flake)

```nix
# flake inputs
inputs.selphy-print.url = "path:/path/to/selphy-print"; # or a git url

# configuration
imports = [ selphy-print.nixosModules.default ];
services.selphy-print = {
  enable = true;
  port = 8080;
  printerHost = "192.168.1.42";           # or CP1500xxxxxx.local
  # The two free profiles are fetched at build time and selectable per photo;
  # override `iccProfilesDir` to supply your own, or `iccProfile` to pin a default.
};
```

The module fetches the ICC profiles, runs as a `DynamicUser`, and archives
prints under `/var/lib/selphy-print`. The companion APK is the prebuilt
`web/selphy-share.apk` (build it with gradle as below, or let the Docker image
compile it). The package uses `buildNpmPackage` with `npmDepsHash =
lib.fakeHash`; the first build aborts printing the real hash — paste it into
`flake.nix` once.

## Configuration (environment variables)

| Variable        | Default            | Meaning |
|---|---|---|
| `PRINTER_HOST`  | *(required)*       | CP1500 IP or mDNS hostname (`CP1500xxxxxx.local`) |
| `PRINTER_URL`   | `ipp://HOST:631/ipp/print` | Full IPP URL override (only the IPP/JPEG transports use it) |
| `PRINT_FORMAT`  | `cpnp`             | Transport. `cpnp` = true borderless + firmware color (default); `jpeg`/`urf`/`pwg` are experiments only |
| `MEDIA_VARIANT` | `borderless`       | `borderless` (full-bleed canvas) or `plain` (1:1 on bare paper; IPP path only) |
| `ICC_PROFILE`   | *(none)*           | Absolute path to the printer ICC profile; unset = no color management |
| `ICC_DIR`       | `./profiles`       | Directory scanned for selectable `*.icc` profiles (client picks per print) |
| `ICC_INTENT`    | `relative`         | `relative` (accurate in-gamut, + black-point compensation), `perceptual`, `saturation`, `absolute` |
| `JPEG_QUALITY`  | `100`              | Quality of the JPEG sent to the printer (near-lossless on the LAN) |
| `OVERSCAN_MM`   | *(measured/calibrated)* | Per-edge trim `"top,bottom,left,right"` in mm (crop-editor orientation; matches the calibration page's T/B/L/R letters) |
| `BLUE_MM`       | `2,2`              | Calibration visual only: width of the blue overscan band per short end (mm) |
| `PAPER`         | `postcard`         | Paper/geometry preset (KP-108IN postcard) |
| `PRINT_ARCHIVE_DIR` | `./print-archive` | Where each print is archived (original + rendered); `off` disables it |
| `MAX_UPLOAD_MB` | `64`               | Max upload size for bulk shares |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `LOG_LEVEL`     | `info`             | Fastify log level |

## Printer setup (once)

1. Connect the CP1500 to your WiFi (printer menu → Wi-Fi settings). Give it a
   DHCP reservation so `PRINTER_HOST` stays valid.
2. **Disable Auto Power Down** in the printer menu — otherwise it turns itself
   off after ~5 minutes idle.
3. If the printer keeps dropping off the network, disable IPv6 on it
   (Wi-Fi settings → Other settings → IPv4/IPv6) — a known CP1500 quirk.
4. Note the printer's **Image Optimize** setting: an ICC profile is only valid
   for the device settings it was profiled with. If prints look off, try
   toggling it and compare.

## Android install & share

**Chrome (with Play services):**

1. Open the HTTPS URL in Chrome → menu → **Install app** (on newer Chrome:
   "Add to Home screen" → **Install** — *not* "Create shortcut"! A shortcut
   looks identical on the home screen but never registers in the share
   sheet).
2. Verify the install is real: the app must appear under Android
   **Settings → Apps** (and in `chrome://webapks`). The share-sheet entry
   appears once Android finishes minting the WebAPK (usually seconds).
   Then: Gallery/Google Photos → select one **or many** photos → Share →
   **Selphy Print**.

**Firefox / Vanadium / GrapheneOS:** the browser-only path cannot work
there — Android share-sheet entries exist only inside WebAPKs, and:

- Firefox has no Web Share Target support at all;
- Vanadium won't add WebAPKs since they're minted on Google's servers
  ([Vanadium#714](https://github.com/GrapheneOS/Vanadium/issues/714),
  [os-issue-tracker#2444](https://github.com/GrapheneOS/os-issue-tracker/issues/2444));
- even real Chrome **with sandboxed Google Play** fails: the WebAPK install
  flashes a dialog, silently falls back to a shortcut, and `chrome://webapks`
  stays empty — open bug
  [os-issue-tracker#6071](https://github.com/GrapheneOS/os-issue-tracker/issues/6071),
  no known workaround. (The ecosystem fix would be an
  [open minting server](https://bugs.chromium.org/p/chromium/issues/detail?id=1243583),
  stalled for years.)

Use the bundled **companion app** instead — functionally it *is* what a
WebAPK would have been (a tiny APK with a share intent-filter), just built
locally instead of by Google:

1. On the phone, open the web app → printer status pill → *install the tiny
   companion app* (serves `selphy-share.apk`, ~29 kB, built from
   [`android/`](android/), no dependencies, no Google).
2. Open it once and set the server URL.
3. Share images (single or bulk) from any app → **Selphy Print** appears in
   the share sheet. It uploads them to the server inbox and opens the web
   app with the photos queued — same flow as the PWA share target.

You can still "Add to Home screen" from Firefox/Vanadium for a launcher icon;
crop UI and printing work in any browser — only share-sheet registration
needs the companion.

### Building the companion APK

`cd android && ANDROID_HOME=<sdk> gradle assembleRelease`; the output lands in
`android/app/build/outputs/apk/release/` — copy it to `web/selphy-share.apk`.

The signing keystore (`android/keystore.jks`) is a private key and is **not**
committed. The first build generates a fresh self-signed one automatically
(needs `keytool` from the JDK on your `PATH`). That keystore stays local: keep
and reuse it so your rebuilt APKs install as updates over each other. A
different clone generates a different key, so its APKs won't update yours — if
you want a stable identity across machines, copy your `keystore.jks` over or
pin your own via `SELPHY_STORE_PASSWORD`, `SELPHY_KEY_ALIAS`,
`SELPHY_KEY_PASSWORD` (gradle properties or env). The in-repo default passwords
are dev-only and harmless without the (uncommitted) keystore.

> If you change `share_target` in the manifest, uninstall and reinstall the PWA
> (Android caches it aggressively). A single shared photo opens the crop editor
> directly; bulk shares land in the queue.

## Crop UI

- The frame is what prints: the render is pre-compensated for your
  calibrated borderless trim, so the full frame lands on paper. The thin
  dashed line marks the ~±1 mm feed-tolerance band at the edges. Drag to
  move, pinch/scroll to zoom, ⟳ to rotate.
- "White border" renders to the printer's bordered printable area
  (2.5 mm sides / 3.7 mm ends) instead of full bleed — nothing is trimmed in
  that mode.
- **Where the trimmed content physically goes** (postcard paper is
  100×178 mm before you tear off the perforated stubs on the short ends):
  the end-overflow (editor left/right) prints *onto the tear-off stubs*, so
  you see it until you tear them — while the side-overflow (editor
  top/bottom) is sprayed past the paper's long edges inside the printer and
  is never visible. Both are real image loss; only one leaves evidence.
- **Calibration:** tap the printer status pill → *Print calibration page*.
  The print carries mm rulers counted inward from each edge plus the letters
  **T/B/L/R** (hold it so T reads on top — that matches the crop editor's
  orientation). On the short ends, read the tick **at the tear-off
  perforation**, not at the stub's outer edge. The first readable tick next
  to each letter is your unit's real trim on that edge; enter the four values
  in the same sheet (stored per device in the browser and sent with every
  print job; server-wide defaults via `OVERSCAN_MM`). From then on every
  borderless print is pre-compensated with those values. Opposite edges
  genuinely differ (~1–2 mm feed offset), which is why calibration is per
  edge. The calibration page itself always prints uncompensated, so
  re-measuring stays meaningful.

## Color notes

- The bundled fetch script grabs two free profiles — the
  [farbenwerk CP1500 profile](https://www.farbenwerk.com/en/blogs/news/canon-selphy-cp1500-icc-profile)
  (neutral) and the [objektiv-guide CP1500 profile](https://www.objektiv-guide.de/)
  (more saturated). Drop any `*.icc` into `profiles/` (or point `ICC_DIR`
  elsewhere) and it becomes selectable per photo. Other options:
  [Zygomatic Color's free CP-series sample](https://zm-color.com/post/2020/05/13/for-canon-selphy-cp-series-sample-icc-profile/),
  paid CP1500 profiles from hkphoto.com, or a custom-made profile for your
  exact paper batch (best).
- ICC pipeline: embedded profile honored (sRGB assumed if untagged) → converted
  to the printer profile via littleCMS `tificc` on lossless pixels (relative
  colorimetric + black-point compensation by default, see `ICC_INTENT`), then
  encoded as a single baseline 4:4:4 JPEG → sent **untagged**, since the printer
  assumes sRGB and its own correction is already baked into the profile.
  (`tificc`, not `jpgicc`: `jpgicc` re-encodes at 4:2:0 with no way to stop it,
  discarding chroma the head can't recover.)
- **Firmware auto-correct** mode sends no ICC — it just sets the CPNP
  `imageOptimize` flag so the printer does its own content-adaptive correction
  (the Preview shows the un-optimized image, since that adjustment happens
  in-printer and can't be reproduced client-side).

## Tests

```bash
npm test    # render pipeline + IPP + PWG encoders against ippeveprinter (needs cups-ipp-utils)
npm run e2e # headless-Chrome test of the full UI flow (needs puppeteer dev dep)
```

## Acknowledgements

Canon's CPNP transport is undocumented; this project's implementation
(`server/cpnp.js`, notes in [`docs/cpnp-protocol.md`](docs/cpnp-protocol.md))
was reconstructed by analysing Canon's **SELPHY Photo Layout** Android app and
cross-checking against prior open-source work, which was invaluable:

- [**selphy_print**](https://git.shaftnet.org/gitea/slp/selphy_print) by
  Solomon Peachy — the CUPS backend for Canon SELPHY printers (incl. the
  CPNP/"CPneo" series).
- [**selphy_go**](https://github.com/tbleher/selphy_go) by tbleher — a Go
  implementation of the CPNP print flow.
- The free CP1500 ICC profiles from
  [farbenwerk](https://www.farbenwerk.com/en/blogs/news/canon-selphy-cp1500-icc-profile)
  and [objektiv-guide](https://www.objektiv-guide.de/).

Geometry facts also draw on the Gutenprint `print-dyesub.c` dye-sub driver.
