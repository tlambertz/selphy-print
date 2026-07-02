# selphy-print — CPNP handoff / debugging brief

**CORRECTION 2 (2026-07-02, even later), measured:** the two JPEG paths are
NOT the same pipeline. A canvas-padded (1248×1872) image sent over IPP JPEG
printed its padding as visible inset white borders (5.0/4.1 mm ends, 3.3 mm
sides = exactly our 60/32 px pads + letterbox): **IPP JPEG aspect-FITS onto
the paper/page area, no canvas overscan; only CPNP fill-scales onto the
1248×1872 head canvas.** Geometry per path: IPP JPEG → render at page
1748×1181, calib bleed only (original geometry); CPNP → render at canvas
with structural bleed {ends:60, sides:32}px + calib. The paragraph below
overclaims a single rule — read it with this correction.

**CORRECTION (2026-07-02, late night), user-verified on physical prints:**
the IPP-era verdict "JPEG prints bordered / length hard-clipped to 140.6 mm /
full-bleed ends impossible" was WRONG — the user confirms the very first IPP
JPEG print ALSO ran past the perforations, exactly like CPNP, just at a
different scale factor (different input size → different fill scale). The
"white bars at the short ends" that condemned the JPEG path were the
KP-108IN TEAR-OFF STUBS (15 mm each end, physically outside the print
window, never fully inkable). The "firmware black box" dissolves into one
deterministic rule: **any JPEG, via IPP or CPNP, is decoded and
aspect-FILL-scaled onto the 1248×1872 head canvas, centered on the sheet,
full bleed, always.** ("Identical output for page-size/canvas/supersize
JPEGs" and "print-scaling ignored" both follow trivially from this rule.)
URF/PWG raster paths are genuinely different (URF bordered, PWG rejected).
CPNP stays the default for determinism + progress/error reporting; the IPP
JPEG fallback now renders at the canvas too (server/index.js).

**Status (2026-07-02, night): SOLVED — CPNP borderless prints work.**
Blank page = ignored consumed-count acks (fixed). "White borders" = the
tear-off stubs of the KP-108IN sheet plus wrong render size. Measured
firmware model (calibration prints + 50 mm bars printing at 52 mm):
**the CP1500 aspect-FILL-scales any CPNP JPEG onto its 1248×1872 head canvas**
(= 1872/1800 = 1.04 on that test) and centers it on the physical 100×178 mm
sheet; ink crosses both perforations → full bleed after tearing. Render
target is now the canvas itself (scale 1.0): photo composed for the centered
paper window, mirrored bleed = structural canvasBleed {ends:60, sides:32}px
+ per-edge registration calibration. Like Canon's app we ALWAYS send
borderless=2; bordered = white frame baked into the image. Remaining:
verify one calibration sheet (expect first ticks ≈1 mm, bars = 50 mm),
then ICC/color work.

**Status (2026-07-02, evening):** Blank-page root cause almost certainly found
by byte-for-byte diff against the decompiled app, and **fixed in code, but NOT
yet tested on hardware** — the printer's CPNP daemon is wedged (UDP 8609
completely silent while HTTP/mDNS answer; sessionEnd sweep of ids 1–64 didn't
revive it). **It needs a power cycle**, then run `node test/cpnp-print.mjs`.

The bug: every CPNP DATA (0x21) ack carries a **consumed-byte count** (u32
big-endian, ack payload bytes 0–3). Canon's app (`CPNPSock.write`) advances by
that count and re-sends unconsumed bytes; our client ignored it and barrelled
on. If the printer consumes less than a full 33792-byte frame, bytes silently
vanish → JPEG in the spool is corrupt → engine runs, page prints blank, every
result code reads 0. The app also does GetMaxWriteSize (0x51) after
SetMaxWriteSize and frames at what the printer *granted* — we assumed 33792.
Both fixed in `server/cpnp.js` (`writeData`, `negotiateMaxWriteSize`).

**Status (2026-07-02, morning):** The CP1500 **physically prints via CPNP** —
paper feeds, the engine runs, a page comes out — but **the page is BLANK**.
Transport is solved; the image data is not landing on the dye.

---

## 1. The goal & the big picture

Self-hosted PWA that prints photos to a **Canon SELPHY CP1500** dye-sub printer
with borderless output + ICC color. The web/PWA/ICC/crop side all work. The one
remaining problem is the **printer transport**.

Printer is on the LAN at **192.168.1.240**. There is no paper-cost concern for
the debugger's understanding, but the *user* pays per sheet — be economical with
real prints; almost everything can be validated without paper (see §7).

### Why CPNP (not IPP)
- The CP1500 speaks IPP Everywhere, but **IPP cannot express "borderless"** in a
  way this firmware honors. Over IPP: JPEG prints but is clipped/bordered; PWG
  raster is rejected ("cannot read data"); URF prints but always bordered.
  Confirmed exhaustively on hardware.
- Canon's own **SELPHY Photo Layout** app uses the proprietary **CPNP** protocol
  over UDP+TCP port 8609. We decompiled it (jadx) and also used the older
  **tbleher/selphy_go** reverse-engineering as the working reference.
- CPNP carries a **border flag** (2=borderless / 3=bordered) → the whole reason
  we went down this path.

---

## 2. Current state machine (WORKING transport, BLANK output)

Implemented in **`server/cpnp.js`** (`cpnpPrint(host, jpeg, opts)`).
Validated flow against the real printer:

```
UDP sessionStart  → reply gives dynamic TCP port + sessionId
TCP connect (dynamic port; opens ~1s after sessionStart, needs retry)
SetMaxWriteSize 0x8400 (33792) over TCP
loop { poll status (TCP op 0x20); act on status byte 0x12 = state }
  state 0 = wait
  state 1 = send 64-byte FLAGS packet (border byte @0x12)
  state 2 = data request (offset@0x18, length@0x1c) → send transfer
  state 3 = done
  state 4 = error ; status byte 8 = 0x0c = "no paper cassette"
```

Last real run (with paper): `flags → sent off=16 len=1 → sent off=0 len=105278
→ printing → done`, then a **blank sheet fed out**. So: exactly one full image
transfer, printer accepted it, printed blank.

---

## 3. CPNP wire protocol (fully reverse-engineered)

**Framing** (16-byte header). Outer fields BIG-endian; inner command/spool
payload fields LITTLE-endian.
```
0..3  "CPNP" (43 50 4e 50)
4     0x01 request / 0x81 reply
5     opcode
6..7  result code (reply), big-endian
8..9  packetId (big-endian, increments, wraps to 1)
10..11 sessionId (big-endian) — MUST be echoed in every TCP frame after session
12..15 payload length (big-endian)
16..  payload
```
Opcodes: discover 0x30, sessionStart 0x10, sessionEnd 0x11, DATA/write 0x21,
getMaxWriteSize 0x51, setMaxWriteSize 0x52, status-read 0x20.

**Ports:** UDP 8609 for discovery + sessionStart/End; the TCP data port is
**dynamic**, returned in the sessionStart reply at **bytes 20-21** (e.g. 0xC001
= 49153, increments each session). sessionId at reply bytes 10-11.

**sessionStart** (UDP): 408-byte datagram. 24-byte base
`43 50 4e 50 01 10 00 00 [pid@8-9] 00 00 [len 0x0188 @14-15 big-endian] ...`,
then UTF-16BE computer name @24, sessionUser "SPL v2.0" @88, sessionDocument
"Square" @152, zero-padded to 408. Reply result must be 0.

**Status read** (TCP op 0x20, sessionId set): reply payload is the status
struct, LITTLE-endian:
- byte 0x08 = statusCode/cassette (0x0c = no cassette)
- byte 0x12 = **state** (0/1/2/3/4) — the state machine driver
- u32 @0x18 = requested offset
- u32 @0x1c = requested length

**Flags packet** (state 1, sent as DATA op 0x21), 64 bytes:
```
@0x04 (u32 LE) = 0x40 (length)
@0x0c (u32 LE) = 1
@0x12 (u32 LE) = 2 borderless / 3 bordered
```

**Data transfer** (state 2, DATA op 0x21). From selphy_go `file_header` +
`get_chunk`: a single **0x68 (104) byte header** then `length` bytes of file
(zero-padded past EOF), the whole thing streamed across ≤maxwrite frames:
```
header (104 bytes, LE):
  @0x02 = 1            (commandCode)
  @0x04 = length+0x68  (total data size)
  @0x0c = 1
  @0x14 = whole JPEG file size
  @0x18 = width
  @0x1c = height
  @0x60 = offset
  @0x64 = length       (the whole requested length)
then: length bytes of jpeg[offset..], zero-padded past EOF
```
NB: selphy_go sends the header+data stream in **4096-byte** CPNP frames. We
currently send in **33792-byte** frames (negotiated maxwrite). **This is a prime
blank-page suspect — try 4096.**

**Done** (state 3): 64-byte packet, @0x04=0x40, byte[2]=0x03.

**Stuck sessions:** killing a test mid-run leaves the printer's session
occupied (sessionStart returns the same id, TCP port refused). Clear by sending
UDP sessionEnd (op 0x11) for recent session ids — see `test/cpnp-selphygo.mjs`
teardown and the inline cleanup one-liners in the git history.

---

## 3.5 Corrections from the decompiled-app diff (2026-07-02 evening)

Byte-for-byte audit of `CPNPMakedata`/`CPNPSock`/`CPNPConnected`/
`CPPrintCommandExecutor` (all field offsets confirmed from the constants at the
top of `CPNPMakedata.java`):

- **DATA ack = consumed count.** Reply payload bytes 0–3 (u32 BE) of every
  0x21 ack say how many bytes the printer consumed. `CPNPSock.write` advances
  the send window by exactly that and re-sends the rest. THE prime blank-page
  suspect; now honoured in `writeData`.
- **GetMaxWriteSize (0x51) after SetMaxWriteSize (0x52)** — frame at the
  granted value (reply payload u32 BE), not the requested one.
- **Transfer header (104 B, LE), authoritative:** @0 u16 commandType=0 ·
  @2 u16 code=1 · @4 u32 = 104+partialLen (NOT 104+wholeRequest… the app uses
  the partial write's length; selphy_go used the whole request — with full
  consumption they're identical) · @8 u32 printDataType=0 · @12 u32
  totalImages=1 · **@16 u32 jpegImageNo=0 (NOT 1)** · @20 u32 whole JPEG size ·
  @24/@28 u32 width/height · **@32 u8 overcoatSetting** (app default 2 =
  NO_CLIENT_DATA; we send 0 = AUTO, selphy_go parity) · @96/@100 u32 partial
  offset/size. **Nothing lives at @14** — the old test script's
  `printSize=4 @0x0e` and `imageNo=1 @0x10` were wrong (both now fixed).
- **Status `dataRequest` is a u32 LE @0x10**, not just a state byte:
  0x10000 START_PRINT · 0x20000|pageIndex PRINT_DATA (low byte = requested
  page; CP mask 0xFFFFFF00) · **0x2FFxx = OC_DATA request** (would look like
  "state 2" with 0xFF in byte 0x11!) · 0x30000 END_PRINT · 0x40000 CANCEL ·
  0x70000 EXECUTE_SPOOL_PRINT. Retry counter u32 @0x14: the app re-serves a
  data request only when (request, retry, extra, extra2) changes.
- **The app's CP flow is startSpool (code 7, 192 B) → data → executeSpoolPrint
  (code 8) → endPrint**, not the legacy startPrint/flags path we use. Ours
  demonstrably drives the engine, so it stays — but if pages still print blank
  after the ack fix, switching to the spool flow is plan B (the border byte
  @18=2 in startSpool is where borderless officially lives).
- **JPEG format hypothesis demoted:** `PrintImageUtil.getImageStream` sends the
  file bytes verbatim — an Android `Bitmap.compress` baseline JPEG, no EXIF.
  A bare sharp baseline JPEG matches what Canon itself sends.

## 4. THE BLANK-PAGE PROBLEM — hypotheses, ranked (PRE-DIFF, see §3.5)

The printer prints (engine runs) but nothing appears. The image bytes are not
being parsed into the print raster. Most likely causes:

1. **Frame size 33792 vs 4096.** selphy_go streams the header+data in 4096-byte
   CPNP DATA frames. We use 33792. The firmware may require 4096-byte frames (or
   may mis-handle a header that spans into a large frame). **Try 4096 first** —
   cheap, high-probability.
2. **JPEG format the firmware can't decode.** selphy_go printed **camera JPEGs
   with EXIF** (the dump shows a full EXIF/Samsung header). Our test JPEG is a
   bare sharp-encoded baseline JPEG, possibly without EXIF, possibly with a
   subsampling/marker the SELPHY JPEG decoder dislikes. The SELPHY wants
   baseline sRGB. Try: real camera JPEG; ensure baseline (not progressive),
   4:2:0 or 4:4:4, add minimal EXIF with dimensions, sRGB. The firmware reads
   width/height from the JPEG — if it can't, it may blank.
3. **Header field wrong for the neo/CP1500 variant.** We took the header from
   selphy_go (CP900-era). The CP1500 "neo" header may need extra fields
   (printSize @0x0e = 4 for postcard? overcoat? image number?). The decompiled
   modern app (`CPNPMakedata.makePrintDataTransfer`,
   `setTransferPrintDataHeaderCP`) is the authority — cross-check every offset.
   See `docs/cpnp-protocol.md` and the decompiled source (§6).
4. **The probe response (off=16 len=1) is being mishandled** and desyncs the
   parse. Watch whether sending it as a full 104+1 transfer is right, or whether
   the first request should be answered differently.
5. **Missing overcoat/finish layer.** CP1500 (gen2CP) supports `surfaceFinish`/
   `overcoat`. If the firmware expects an overcoat data phase and gets none, it
   might feed a blank sheet. Check `CPNPMakedata` OC_DATA path.
6. **Image geometry.** We render 1184×1752 (portrait, ceil(mm×11.835)). If the
   firmware expects a different exact size for CP_POST it may not rasterize.

Suggested first experiment: in `test/cpnp-selphygo.mjs`, switch the data frame
size to 4096 AND feed a real camera JPEG (baseline, EXIF). If it prints, bisect
which of the two mattered.

---

## 5. Files that matter

- **`server/cpnp.js`** — the CPNP client (current, blank-page). `cpnpPrint()`,
  `makeFlags()`, `makeTransfer()`, `readStatus()`, session helpers.
- **`server/render.js`** — `renderForPrint` (crop→JPEG at canonPage 1752×1184→
  portrait), `renderCalibration` (mm ruler page). ICC via `jpgicc`/`tificc`.
- **`server/index.js`** — `/api/print`, `/api/calibrate`; `PRINT_FORMAT=cpnp`
  branch calls `cpnpPrint`. Fallbacks: urf/pwg/jpeg (all bordered/failed).
- **`server/config.js`** — `paper.canonPage = {w:1752,h:1184}`, overscan, etc.
- **`docs/cpnp-protocol.md`** — earlier protocol write-up (some of it predates
  the selphy_go-based correction; trust THIS doc + selphy_go over it where they
  differ).

### Test scripts (all take the printer IP as argv[2], default 192.168.1.240)
- `test/cpnp-handshake.mjs` — paper-free: discovery→session→dynamic TCP→
  setMaxWriteSize→sessionEnd. Health check.
- `test/cpnp-selphygo.mjs` — **the faithful selphy_go port**; the thing that
  drove the printer to actually print. Best place to iterate the blank-page fix.
- `test/cpnp-experiment.mjs` — verbose status dumper.
- `test/cpnp-probe-tcp.mjs`, `test/cpnp-dryrun.mjs` — earlier probes.

Run one, e.g.: `cd /workspace/selphy-print && node test/cpnp-selphygo.mjs`.

---

## 6. Reference material on disk

- **Decompiled Canon app** (jadx): `/tmp/.../scratchpad/spl-src/sources/jp/co/
  canon/ic/photolayout/` — the ground truth. Key classes:
  `model/printer/internal/cpnp/` (CPNP.java, CPNPSock.java, CPNPMakedata.java,
  CPNPConnected.java, CPNPUDP.java, CPNPTrans.java),
  `model/printer/internal/operation/CPPrintCommandExecutor.java`.
  `CPNPMakedata.makePrintDataTransfer` / `setTransferPrintDataHeaderCP` is the
  authoritative data-header builder for the CP1500 — **diff our `makeTransfer`
  against it byte-for-byte.**
  APK at `scratchpad/xapk/`; `assets/printer_support.json` has
  `pixel_per_mm=11.835`, `support_borderless`, `print_safe_area_inflate=-10px`.
- **selphy_go** (working, older printers): fetched to `scratchpad/selphy.go` and
  `scratchpad/send-protocol.txt` (a real traffic dump — invaluable). Also
  github.com/tbleher/selphy_go.
- **jadx**: `scratchpad/jadx/bin/jadx`.

---

## 7. How to debug without wasting paper

- Discovery, sessionStart, TCP connect, SetMaxWriteSize, flags, and even the
  full data transfer can all be exercised and their results/acks read WITHOUT a
  print, as long as you STOP before the printer commits to feeding. But note:
  once state reaches "done"/idle with the image in, the printer may feed. The
  no-cassette error (status byte 8 = 0x0c) is the safe signal that you reached
  the print stage without a sheet.
- To iterate the JPEG-format / frame-size hypotheses, watch the **status byte
  0x12 progression** and the **acks** — a correctly consumed transfer advances
  the state; a rejected one makes the printer re-request the same offset.
- Always clear stuck sessions between runs (UDP sessionEnd for recent ids).

---

## 8. What's already ruled out (don't redo)

- IPP (JPEG/PWG/URF) — none give borderless; JPEG clips, PWG rejected, URF
  bordered. Confirmed on hardware.
- CPNP over a fixed TCP port (8609) — the data port is dynamic (§3).
- Sending a fresh 104-byte header per frame — that caused the infinite off=0
  re-request loop. One header per request, streamed. (Just fixed in cc374f8.)
- startSpool (command code 7) — that's not in the working path; the flags packet
  is. (An earlier wrong turn.)

---

## 9. TL;DR for the next session

Root cause identified (§3.5: ignored consumed-count acks + unverified max
write size) and fixed in `server/cpnp.js`, **untested** — the printer's CPNP
daemon is wedged and needs a POWER CYCLE first. Then:

1. `node test/cpnp-print.mjs` — drives the real `cpnpPrint()` with a 6-bar
   colour test page (unmistakable vs blank). Watch for `partial ack:` log
   lines — their presence confirms the diagnosis.
2. If STILL blank: plan B = switch to the app's spool flow (startSpool 192 B
   code 7 → data → executeSpoolPrint code 8 → endPrint), and/or set
   overcoatSetting @32 = 2. `makeStartSpool` already exists in server/cpnp.js.
3. Then wire-test `/api/print` end-to-end (`PRINT_FORMAT=cpnp`).
