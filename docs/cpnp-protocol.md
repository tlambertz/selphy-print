# CP1500 wire protocol — reverse-engineered from SELPHY Photo Layout 4.3.10

Source: decompiled `jp.co.canon.ic.photolayout` (jadx), classes under
`model/printer/internal/cpnp/` and `assets/printer_support.json`.

## The key discovery

Canon's own app does **not** print over IPP. It uses the proprietary **CPNP**
protocol and sends a **JPEG** wrapped in a spool header whose **border-setting
byte selects borderless**. This is why the identical JPEG clips at the ends
over IPP but goes full-bleed from Canon's app: the borderless request lives in
the CPNP spool header, and the IPP path never conveys it in a form the
firmware honours.

## printer_support.json (CP1500 = `gen2CP`)

- `pixel_per_mm = 11.835`  (= 300.6 dpi, NOT exactly 300)
- `support_borderless = true`
- `print_safe_area_inflate = { left:-10, top:-10, right:-10, bottom:-10 }` px
  → only ~0.85 mm safe inset per edge; Canon renders essentially the whole
  paper with a small bleed and lets the firmware overscan.
- papers: `cpPostcard` (cpp), `cpL` (cpl), `cpCard` (cpc)
- Print image pixels = `ceil(paper_mm * pixel_per_mm)`
  → postcard ≈ ceil(100×11.835) × ceil(148×11.835) = **1184 × 1752 px**

## CPNP framing (`CPNPSock`)

All packets start with ASCII `CPNP` = `{67,80,78,80}`. Byte 4 = 0x01 for
requests / 0x81 for replies; byte 5 = opcode.

| Packet | Bytes (opcode) | Meaning |
|---|---|---|
| Session start | `01 10` … `01 88` … | STARTTCP; last 8 bytes carry a length (0x0188) |
| Session end | `01 11` | end job |
| Write (data) | `01 21` | data chunk |
| Write check | `81 21` | data-chunk ack |
| Get max write size | `01 51` / ack `81 51` | negotiate chunk size |
| Set max write size | `01 52` … `00 00 84 00` | set chunk = 0x8400 = 33792 bytes |

- Data chunking: `sendBuffer = 64 + 33792` (64-byte header + 33792 payload).
- Transport: UDP (`CPNPUDP`, `UdpClient`) for discovery, TCP (`TcpClient`)
  for the session/data. `defaultMaxDataWriteSize = 33792`.

## Spool header (`CPNPMakedata`)

Start-spool packet (`sizeStartSpool = 192` bytes) fields:
- offset 12: total JPEG images (=1)
- offset 16: JPEG image number
- offset 18: **border setting** — `boarderSettingBorderless = 2`
  (matches go-selphy-cp: 2 = borderless, 3 = bordered)
- offset 20: JPEG data size
- offset 24: **JPEG width**
- offset 28: **JPEG height**
- offset 32: spool JPEG file size
- overcoat / surface-finish fields follow (CP1500 `surfaceFinish`, `overcoat`)

Payload is a plain JPEG (`typeJpegEasyPrint`), sent in ≤33792-byte chunks.

## Consequences for selphy-print

Two viable full-bleed paths:

1. **URF over IPP** (currently implemented, CONFIRMED to physically print).
   If `MEDIA_VARIANT=borderless` yields full bleed, we need nothing else.
2. **CPNP** (what Canon does; guaranteed full bleed via border byte = 2).
   Bigger build: UDP discovery → TCP session → GetMax/SetMax write size →
   192-byte start-spool with border=2 + JPEG w/h/size → 33792-byte data
   chunks → session end. Port: the app uses UDP discovery to find/open the
   TCP endpoint; a raw TCP connect to 8609 without the UDP handshake returned
   closed in testing, so implement discovery first. All framing constants are
   above.

Render geometry for either path: JPEG at `ceil(mm * 11.835)` (postcard
1184×1752), content kept ≥~0.85 mm from each edge; the firmware overscans.
