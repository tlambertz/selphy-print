# selphy-print

A self-hosted PWA that prints photos to a **Canon SELPHY CP1500** over WiFi with
proper ICC color management. Install it on Android, share photos to it from your
gallery (single or bulk), crop them to the printer's real geometry, and print.

```
Android share sheet ──► PWA (crop UI, queue) ──► Node server ──► ICC convert ──► IPP ──► CP1500
```

## Why this exists

- **The "borders thing":** the SELPHY's native print canvas is 1872×1248 px
  (exactly 2:3), but the visible paper is only the central 1748×1181 px
  (100×148 mm). Borderless prints are always overscanned ~3 mm per edge and the
  edges get chopped. The crop UI here frames at the true 2:3 canvas and shows a
  dashed **safe-area guide** for what will actually be visible on paper.
- **Color:** the CP1500 has a fixed internal color pipeline that cannot be
  disabled and tends to oversaturate with a bluish cast. The server converts
  every image into a printer ICC profile (which characterizes that whole
  pipeline) before sending, so prints come out color-accurate.

## Quick start (dev)

```bash
npm install
npm run fetch-profile          # downloads the free farbenwerk CP1500 profile
PRINTER_HOST=192.168.1.42 ICC_PROFILE=$PWD/profiles/CP1500-farbenwerk.icc npm start
# open http://localhost:8080
```

## Deploying

The app must be served over **HTTPS with a browser-trusted certificate**,
otherwise Android will not install the PWA and the share-sheet integration
(`share_target`) will not register. Point your reverse proxy at the server's
plain-HTTP port. No special headers needed; allow request bodies up to ~64 MB
for bulk shares (nginx: `client_max_body_size 64m;`).

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
  iccProfile = /var/lib/selphy/CP1500-farbenwerk.icc;
};
```

The package uses `buildNpmPackage` with `npmDepsHash = lib.fakeHash`; the first
build aborts printing the real hash — paste it into `flake.nix` once.

### Docker

Edit `docker-compose.yml` (printer IP), then `docker compose up -d`.

## Configuration (environment variables)

| Variable        | Default      | Meaning |
|---|---|---|
| `PRINTER_HOST`  | *(required)* | CP1500 IP or mDNS hostname (`CP1500xxxxxx.local`) |
| `PRINTER_URL`   | –            | Full IPP URL override (default `ipp://HOST:631/ipp/print`) |
| `ICC_PROFILE`   | *(none)*     | Absolute path to the printer ICC profile; unset = no color management |
| `ICC_INTENT`    | `perceptual` | `perceptual` (smooth, saturated photos) or `relative` (accurate in-gamut, + black point compensation) |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `PRINT_SCALING` | `fill`       | IPP print-scaling sent with each job |
| `JPEG_QUALITY`  | `95`         | Quality of the JPEG sent to the printer |

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

1. Open the HTTPS URL in Chrome → menu → **Install app**.
2. The share-sheet entry appears once Android finishes minting the WebAPK
   (usually seconds). Then: Gallery/Google Photos → select one **or many**
   photos → Share → **Selphy Print**.
3. A single shared photo opens the crop editor directly; bulk shares land in
   the queue — tap any photo to adjust its crop, rotation, or copy count.
4. If you ever change `share_target` in the manifest, uninstall and reinstall
   the PWA (Android caches it aggressively).

## Crop UI

- The frame is the printer's true 2:3 canvas; **the dashed line is the
  safe area** — anything outside it may be trimmed by the printer's borderless
  overscan. Drag to move, pinch/scroll to zoom, ⟳ to rotate.
- "White border" prints with the printer's bordered mode (2.5 mm sides /
  3.7 mm ends) instead of full bleed.
- **Calibration:** tap the printer status in the header to print a page of mm
  rulers. The first visible tick on each edge tells you your unit's actual
  overscan; adjust `visible` in `server/config.js` if it differs much from the
  default (34 px sides / 62 px ends).

## Color notes

- The bundled fetch script grabs the free
  [farbenwerk CP1500 profile](https://www.farbenwerk.com/en/blogs/news/canon-selphy-cp1500-icc-profile).
  Alternatives: [Zygomatic Color's free CP-series sample](https://zm-color.com/post/2020/05/13/for-canon-selphy-cp-series-sample-icc-profile/),
  paid CP1500 profiles from hkphoto.com, or a custom-made profile for your
  exact paper batch (best).
- Pipeline: embedded profile honored (sRGB assumed if untagged) → converted to
  the printer profile via littleCMS (`jpgicc`, with black point compensation) →
  sent untagged, since the printer assumes sRGB and its own correction is
  already baked into the profile.

## Tests

```bash
npm test    # render pipeline + IPP client against ippeveprinter (needs cups-ipp-utils)
npm run e2e # headless-Chrome test of the full UI flow (needs puppeteer dev dep)
```
