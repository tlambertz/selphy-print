/* Minimal IPP/1.1 client (RFC 8010 encoding, RFC 8011 semantics).
   Just enough to drive an IPP Everywhere printer like the SELPHY CP1500:
   Get-Printer-Attributes, Print-Job (image/jpeg), Get-Job-Attributes. */

import http from 'node:http';

const OPS = {
  'Print-Job': 0x0002,
  'Get-Printer-Attributes': 0x000b,
  'Get-Job-Attributes': 0x0009,
  'Cancel-Job': 0x0008,
};

const TAG = {
  operation: 0x01,
  job: 0x02,
  end: 0x03,
  printer: 0x04,
  unsupported: 0x05,
  // value tags
  integer: 0x21,
  boolean: 0x22,
  enum: 0x23,
  octetString: 0x30,
  dateTime: 0x31,
  resolution: 0x32,
  rangeOfInteger: 0x33,
  begCollection: 0x34,
  textWithLanguage: 0x35,
  endCollection: 0x37,
  textWithoutLanguage: 0x41,
  nameWithoutLanguage: 0x42,
  keyword: 0x44,
  uri: 0x45,
  uriScheme: 0x46,
  charset: 0x47,
  naturalLanguage: 0x48,
  mimeMediaType: 0x49,
  memberAttrName: 0x4a,
};

/* ---------- encoding ---------- */

class Writer {
  constructor() {
    this.chunks = [];
  }
  u8(v) {
    this.chunks.push(Buffer.from([v & 0xff]));
  }
  u16(v) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(v);
    this.chunks.push(b);
  }
  u32(v) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v);
    this.chunks.push(b);
  }
  str(s) {
    const b = Buffer.from(s, 'utf8');
    this.u16(b.length);
    this.chunks.push(b);
  }
  buffer() {
    return Buffer.concat(this.chunks);
  }
}

function writeAttr(w, valueTag, name, value) {
  w.u8(valueTag);
  w.str(name);
  switch (valueTag) {
    case TAG.integer:
    case TAG.enum:
      w.u16(4);
      w.u32(value);
      break;
    case TAG.boolean:
      w.u16(1);
      w.u8(value ? 1 : 0);
      break;
    default:
      w.str(String(value));
  }
}

// value: { type, value } or array of them; collections: { type:'collection', value: {name: attr} }
function writeAttrGroup(w, groupTag, attrs) {
  w.u8(groupTag);
  for (const [name, spec] of Object.entries(attrs)) {
    const list = Array.isArray(spec) ? spec : [spec];
    list.forEach((item, i) => {
      const attrName = i === 0 ? name : ''; // additional values: empty name
      if (item.type === 'collection') {
        writeCollection(w, attrName, item.value);
      } else {
        writeAttr(w, TAG[item.type], attrName, item.value);
      }
    });
  }
}

function writeCollection(w, name, members) {
  w.u8(TAG.begCollection);
  w.str(name);
  w.u16(0); // no value
  for (const [mName, mSpec] of Object.entries(members)) {
    w.u8(TAG.memberAttrName);
    w.u16(0); // empty name
    w.str(mName);
    if (mSpec.type === 'collection') {
      writeCollection(w, '', mSpec.value);
    } else {
      writeAttr(w, TAG[mSpec.type], '', mSpec.value);
    }
  }
  w.u8(TAG.endCollection);
  w.u16(0);
  w.u16(0);
}

function encodeRequest(op, requestId, groups, data) {
  const w = new Writer();
  w.u8(1); // version 1.1
  w.u8(1);
  w.u16(OPS[op]);
  w.u32(requestId);
  for (const g of groups) writeAttrGroup(w, g.tag, g.attrs);
  w.u8(TAG.end);
  return data ? Buffer.concat([w.buffer(), data]) : w.buffer();
}

/* ---------- decoding ---------- */

function decodeResponse(buf) {
  let off = 0;
  const version = `${buf[0]}.${buf[1]}`;
  const statusCode = buf.readUInt16BE(2);
  const requestId = buf.readInt32BE(4);
  off = 8;

  const groups = [];
  let current = null;
  let lastAttr = null;

  const readStr = () => {
    const len = buf.readUInt16BE(off);
    off += 2;
    const s = buf.toString('utf8', off, off + len);
    off += len;
    return s;
  };

  while (off < buf.length) {
    const tag = buf[off];
    off += 1;
    if (tag === TAG.end) break;
    if (tag < 0x10) {
      current = { tag, attrs: {} };
      groups.push(current);
      continue;
    }
    const name = readStr();
    const valLen = buf.readUInt16BE(off);
    off += 2;
    let value;
    switch (tag) {
      case TAG.integer:
      case TAG.enum:
        value = buf.readInt32BE(off);
        break;
      case TAG.boolean:
        value = buf[off] !== 0;
        break;
      case TAG.rangeOfInteger:
        value = [buf.readInt32BE(off), buf.readInt32BE(off + 4)];
        break;
      case TAG.resolution:
        value = { x: buf.readInt32BE(off), y: buf.readInt32BE(off + 4), unit: buf[off + 8] };
        break;
      default:
        value = buf.toString('utf8', off, off + valLen);
    }
    off += valLen;

    // Skip over collection internals; we don't need them decoded.
    if (tag === TAG.begCollection) {
      let depth = 1;
      value = '<collection>';
      while (off < buf.length && depth > 0) {
        const t = buf[off];
        off += 1;
        if (t < 0x10) break;
        const nLen = buf.readUInt16BE(off);
        off += 2 + nLen;
        const vLen = buf.readUInt16BE(off);
        off += 2 + vLen;
        if (t === TAG.begCollection) depth++;
        if (t === TAG.endCollection) depth--;
      }
    }

    if (name === '' && lastAttr) {
      if (!Array.isArray(current.attrs[lastAttr])) current.attrs[lastAttr] = [current.attrs[lastAttr]];
      current.attrs[lastAttr].push(value);
    } else if (current) {
      current.attrs[name] = value;
      lastAttr = name;
    }
  }
  return { version, statusCode, requestId, groups };
}

/* ---------- transport ---------- */

let nextRequestId = 1;

function post(printerUrl, body, timeoutMs) {
  const url = new URL(printerUrl.replace(/^ipp:/, 'http:'));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port || 631,
        path: url.pathname || '/ipp/print',
        method: 'POST',
        headers: {
          'Content-Type': 'application/ipp',
          'Content-Length': body.length,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`printer HTTP ${res.statusCode}`));
          }
          try {
            resolve(decodeResponse(Buffer.concat(chunks)));
          } catch (err) {
            reject(new Error(`bad IPP response: ${err.message}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('printer connection timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

function opAttrs(printerUrl, extra = {}) {
  return {
    'attributes-charset': { type: 'charset', value: 'utf-8' },
    'attributes-natural-language': { type: 'naturalLanguage', value: 'en' },
    'printer-uri': { type: 'uri', value: printerUrl },
    ...extra,
  };
}

export const STATUS = (code) =>
  code <= 0x0005 ? 'successful' : `ipp-error-0x${code.toString(16).padStart(4, '0')}`;

export async function getPrinterAttributes(printerUrl, timeoutMs = 5000) {
  const body = encodeRequest('Get-Printer-Attributes', nextRequestId++, [
    {
      tag: TAG.operation,
      attrs: opAttrs(printerUrl, {
        'requested-attributes': [
          { type: 'keyword', value: 'printer-name' },
          { type: 'keyword', value: 'printer-state' },
          { type: 'keyword', value: 'printer-state-reasons' },
          { type: 'keyword', value: 'printer-make-and-model' },
          { type: 'keyword', value: 'media-ready' },
          { type: 'keyword', value: 'marker-levels' },
          { type: 'keyword', value: 'marker-names' },
        ],
      }),
    },
  ]);
  const res = await post(printerUrl, body, timeoutMs);
  const printer = res.groups.find((g) => g.tag === TAG.printer);
  return { statusCode: res.statusCode, attrs: printer ? printer.attrs : {} };
}

/**
 * Send a single document as a Print-Job.
 * opts: { jobName, copies, format ('image/pwg-raster' | 'image/jpeg'),
 *         media (keyword, e.g. 'jpn_hagaki_100x148mm'),
 *         borderless (adds zero-margin media-col), printScaling,
 *         mediaSize: {x, y} (1/100 mm) }
 */
export async function printJob(printerUrl, data, opts = {}) {
  const jobAttrs = {};
  if (opts.copies > 1) jobAttrs.copies = { type: 'integer', value: opts.copies };
  if (opts.printScaling) jobAttrs['print-scaling'] = { type: 'keyword', value: opts.printScaling };

  if (opts.borderless) {
    // Borderless media variant: zero-margin media-col (cups-filters#492).
    const mediaCol = {};
    if (opts.mediaSize) {
      mediaCol['media-size'] = {
        type: 'collection',
        value: {
          'x-dimension': { type: 'integer', value: opts.mediaSize.x },
          'y-dimension': { type: 'integer', value: opts.mediaSize.y },
        },
      };
    }
    for (const side of ['top', 'bottom', 'left', 'right']) {
      mediaCol[`media-${side}-margin`] = { type: 'integer', value: 0 };
    }
    jobAttrs['media-col'] = { type: 'collection', value: mediaCol };
  } else if (opts.media) {
    // Plain media keyword: the firmware prints rasters 1:1, no borderless
    // enlargement — the "select the non-borderless variant" recipe.
    jobAttrs.media = { type: 'keyword', value: opts.media };
  }

  const groups = [
    {
      tag: TAG.operation,
      attrs: opAttrs(printerUrl, {
        'requesting-user-name': { type: 'nameWithoutLanguage', value: 'selphy-print' },
        'job-name': { type: 'nameWithoutLanguage', value: opts.jobName || 'photo' },
        'document-format': { type: 'mimeMediaType', value: opts.format || 'image/jpeg' },
      }),
    },
  ];
  if (Object.keys(jobAttrs).length) groups.push({ tag: TAG.job, attrs: jobAttrs });

  const body = encodeRequest('Print-Job', nextRequestId++, groups, data);
  const res = await post(printerUrl, body, opts.timeoutMs || 60000);
  if (res.statusCode > 0x0005) {
    const un = res.groups.find((g) => g.tag === TAG.unsupported);
    throw new Error(
      `Print-Job rejected (${STATUS(res.statusCode)})` +
        (un ? ` unsupported: ${Object.keys(un.attrs).join(', ')}` : '')
    );
  }
  const job = res.groups.find((g) => g.tag === TAG.job);
  return {
    jobId: job?.attrs['job-id'],
    jobState: job?.attrs['job-state'],
  };
}

// job-state enums (RFC 8011): 3 pending, 4 held, 5 processing, 6 stopped,
// 7 canceled, 8 aborted, 9 completed
export async function getJobAttributes(printerUrl, jobId, timeoutMs = 5000) {
  const body = encodeRequest('Get-Job-Attributes', nextRequestId++, [
    {
      tag: TAG.operation,
      attrs: opAttrs(printerUrl, {
        'job-id': { type: 'integer', value: jobId },
      }),
    },
  ]);
  const res = await post(printerUrl, body, timeoutMs);
  const job = res.groups.find((g) => g.tag === TAG.job);
  return job ? job.attrs : {};
}
