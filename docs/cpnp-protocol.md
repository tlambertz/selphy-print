# CP1500 wire protocol (CPNP) — reversing notes

These are the notes behind `server/cpnp.js`: Canon's proprietary CPNP transport
for the SELPHY CP1500, reconstructed so the app can drive true borderless prints
and the printer's firmware colour-correct (neither of which IPP exposes).

**Sources & credits.** Constants and framing were derived by analysing Canon's
**SELPHY Photo Layout** Android app (v4.3.10) and cross-checked against two
existing open-source implementations, without which this would have been far
harder:

- **selphy_print** by Solomon Peachy — the CUPS backend for Canon SELPHY
  printers, incl. the CPNP/"CPneo" series:
  <https://git.shaftnet.org/gitea/slp/selphy_print>
- **selphy_go** by tbleher — a Go implementation of the CPNP print flow:
  <https://github.com/tbleher/selphy_go>

This document records the wire format; the working implementation is
`server/cpnp.js`.

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

The firmware's native head raster is slightly larger — **1248 × 1872 px** for
postcard — which `selphy_print`'s USB backend independently confirms (its
CP1500 raw stream is `cols=1248 rows=1872` at 300 dpi). The app renders at that
1248×1872 canvas so the firmware's fill-scale is 1.0. (Over USB the printer
takes raw YUV444/CMY planes; over the network it takes a JPEG via CPNP — the
same head geometry, different transport.)

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

## Why CPNP (vs IPP)

CPNP is the transport the app implements (`server/cpnp.js`, `PRINT_FORMAT=cpnp`):
it is the only one that yields true full bleed (border byte = 2) and can invoke
the printer's Auto Image Correction. The build is: UDP discovery → TCP session →
GetMax/SetMax write size → 192-byte start-spool with border=2 + JPEG w/h/size →
33792-byte data chunks → session end. Discovery matters — a raw TCP connect to
8609 without the UDP handshake is refused, so the session must be established
first. All framing constants are below.

Render geometry: the app renders at the full head canvas (1248×1872) so the
firmware's fill-scale is 1.0; content is kept clear of the edges and the
firmware overscans the rest off the paper.

## Reachability

The discovery packet
`CPNP 01 30 00 00  00 00 00 00  00 00 00 04  00 00 00 00` to
`udp/<printer>:8609` returns a ~118-byte reply with opcode `81 30` and an
IEEE-1284 device-ID payload (`MFG:Canon;CMD:…`); the raw TCP data port is only
reachable after the CPNP session handshake.

## Complete constants (from CPNPMakedata / CPNPSock / CPNP)

Integers are **little-endian** (`longToBytes`: `b[i]=(v>>(8*i))&0xFF`).

Ports & addresses: `CPNP_PORT = 8609` (UDP control + TCP data).
Session control (start/end) is UDP; max-write negotiation and bulk data are
TCP on the same port.

Packet framing (16-byte base): `43 50 4E 50` ("CPNP"), byte4 `01`=request /
`81`=reply, byte5 = opcode, bytes 8-9 = packetId (big-endian, increments,
wraps to 1), bytes 12-15 = payload length.

Opcodes: GetNicInfo `01`, DeviceId `30`, Read `20`, SessionStart `10`,
SessionEnd `11`, Write(data) `21`, GetMaxWriteSize `51`, SetMaxWriteSize `52`.

- `packetDeviceId`   = `CPNP 01 30 …00 00 00 04 00 00 00 00` (discovery)
- `packetSessionStart` = `CPNP 01 10 …[pid]… 01 88 …` then at offsets past the
  24-byte base: computerName (UTF-16BE `Build.MODEL`, ≤64B) @+0, sessionUser
  @+64, sessionDocument @+128. `sessionUser` = UTF-16BE "SPL v2.0",
  `sessionDocument` = UTF-16BE "Square".
- `packetSessionEnd`  = `CPNP 01 11 …`
- `packetSetMaxWriteSize` = `CPNP 01 52 …00 00 00 04  00 00 84 00`
  (sets chunk = 0x8400 = 33792)
- `packetWriteBase`   = `CPNP 01 21 …` (each TCP data chunk is prefixed by this)

Command/spool payload header (little-endian fields):
- commandType @0 (2B) = `typePrint`
- commandCode @2 (2B): PrintDataTransfer=1, CancelPrint=2, EndPrint=3,
  OcDataTransfer=5, ResumePrint=6, **StartSpool=7**, ExecuteSpoolPrint=8
- commandDataSize @4 (4B) = 104(`sizeTrans`) + payload, or 192 for start-spool
- printDataType @8 (4B) = `typeJpegEasyPrint`

Start-spool packet (192 B, `makeStartSpool`):
- @0 commandType=typePrint, @2 code=7, @4 size=192, @8 type=jpegEasyPrint
- @12 (2B) totalJpegImages = min(pages,20)
- @14 (2B) printSize — **CP_POST_SIZE = 4** (CP_CARD=2, CP_L=3; AUTO=0)
- @16 (1B) overcoatSetting = 1 (each page)
- @17 (1B) imageOptimize — the app's "color correct"/Auto Image Correction:
  **OFF=2, ON=3** (`CPNPMakedata.ImageOptimizeSetting`). Content-adaptive
  enhancement done entirely in printer firmware (the app applies no pixel math
  for it — its draw-visitor is a no-op). CPNP-only; no IPP equivalent, and the
  Canon app never prints over IPP.
- **@18 (1B) borderSetting = 2 (borderless)**  ← the whole point
- @19 (1B) printFinish
- @32 + i*8 (4B) JPEG file size for image i (+@36 OC size if any)

Per-image transfer (`setTransferPrintDataHeaderCP`, 104-B header + JPEG bytes):
- @0 type=typePrint, @2 code=1 (PrintDataTransfer), @4 size=104+chunk,
  @8 printDataType=jpegEasyPrint
- @12 totalJpegImages, @14 printSize, @16 jpegImageNo, @20 jpegDataSize,
  @24 jpegWidth, @28 jpegHeight, @32 overcoatSetting,
  @96 partialJpegOffset, @100 partialJpegSize
- JPEG sent in ≤33792-B partial chunks; each chunk = 104-B header + data,
  wrapped in a `packetWriteBase` (opcode 21) TCP frame.

Print sequence (`CPPrintCommandExecutor` / `CPNPTrans`):
1. UDP DeviceId discovery (optional; confirms presence)
2. TCP connect :8609 → UDP sessionStart
3. TCP GetMaxWriteSize → SetMaxWriteSize (33792)
4. `sendStartSpool(pages)` — 192-B start-spool with border=2
5. per image: `PrintDataTransfer` chunks (104-B header + JPEG partials)
6. `sendExecuteSpoolPrint()` (code 8)
7. `sendEndPrint()` (code 3) → UDP sessionEnd → TCP close

Still to confirm at build time (values not string-visible in the dump, read
from a live exchange or defaulted): `typePrint`, `typeJpegEasyPrint` (both
appear to be small constants set in the ctor), and the exact session-start
payload length field. Validate the handshake (discovery→sessionStart→
maxwrite→sessionEnd — all paper-free) against the printer before the first
spool print.
