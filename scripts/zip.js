/* global CompressionStream, Response */
/**
 * A small ZIP writer. Files are written one after another to a sink, so only the file being added is held in memory.
 * Text files can be deflated with the browser's CompressionStream, media files are stored as they are (already
 * compressed). ZIP64 records are added when a file, an offset or the entry count passes the 32-bit / 16-bit limits.
 */

/** Values written in place of a number that only the ZIP64 record holds. */
const MAX32 = 0xFFFFFFFF;
const MAX16 = 0xFFFF;
/** From which value ZIP64 is used (only lowered in tests). */
const LIMIT32 = MAX32;
const LIMIT16 = MAX16;
const UTF8_FLAG = 0x0800;

/**
 * A 32-bit header value, or the ZIP64 marker if it is too large.
 * @param {number} value
 * @returns {number}
 */
function cap32(value) {
  return value >= LIMIT32 ? MAX32 : value;
}

let crcTable;

/**
 * CRC-32 of a byte array.
 * @param {Uint8Array} data
 * @returns {number}
 */
export function crc32(data) {
  if ( !crcTable ) {
    crcTable = new Uint32Array(256);
    for ( let n = 0; n < 256; n++ ) {
      let c = n;
      for ( let k = 0; k < 8; k++ ) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for ( let i = 0; i < data.length; i++ ) crc = crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Raw deflate (no zlib header), as ZIP method 8 expects.
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
async function deflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * MS-DOS date and time, as stored in ZIP headers.
 * @param {Date} date
 * @returns {{time: number, day: number}}
 */
function dosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

/**
 * A ZIP64 extended information extra field.
 * @param {number[]} values  The 64-bit values, in the order the format requires
 * @returns {Uint8Array}
 */
function zip64Extra(values) {
  const view = new DataView(new ArrayBuffer(4 + (8 * values.length)));
  view.setUint16(0, 0x0001, true);
  view.setUint16(2, 8 * values.length, true);
  values.forEach((v, i) => view.setBigUint64(4 + (8 * i), BigInt(v), true));
  return new Uint8Array(view.buffer);
}

/**
 * @typedef {object} ZipSink
 * @property {function(Uint8Array): Promise<void>} write
 * @property {function(): Promise<void>} close
 * @property {function(): Promise<void>} [abort]
 */

export default class ZipWriter {
  /**
   * @param {ZipSink} sink
   */
  constructor(sink) {
    this.sink = sink;
  }

  /** Bytes written so far. */
  offset = 0;

  /** Central directory records. */
  #entries = [];

  #encoder = new TextEncoder();

  /** The time stamp of every entry. */
  #date = dosDateTime(new Date());

  /* -------------------------------------------- */

  /** @param {Uint8Array} bytes */
  async #write(bytes) {
    if ( !bytes.length ) return;
    await this.sink.write(bytes);
    this.offset += bytes.length;
  }

  /* -------------------------------------------- */

  /**
   * Add a file.
   * @param {string} name        Path inside the archive, with forward slashes
   * @param {Uint8Array} data
   * @param {object} [options]
   * @param {boolean} [options.compress=false]  Deflate it, if that makes it smaller
   */
  async addFile(name, data, { compress = false } = {}) {
    const nameBytes = this.#encoder.encode(name);
    const crc = crc32(data);
    let method = 0;
    let payload = data;
    if ( compress && (typeof CompressionStream === "function") ) {
      const deflated = await deflateRaw(data);
      if ( deflated.length < data.length ) {
        method = 8;
        payload = deflated;
      }
    }
    const size = data.length;
    const csize = payload.length;
    const zip64 = (size >= LIMIT32) || (csize >= LIMIT32);
    const extra = zip64 ? zip64Extra([size, csize]) : new Uint8Array(0);
    const { time, day } = this.#date;

    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, zip64 ? 45 : 20, true);
    header.setUint16(6, UTF8_FLAG, true);
    header.setUint16(8, method, true);
    header.setUint16(10, time, true);
    header.setUint16(12, day, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, zip64 ? MAX32 : csize, true);
    header.setUint32(22, zip64 ? MAX32 : size, true);
    header.setUint16(26, nameBytes.length, true);
    header.setUint16(28, extra.length, true);

    const offset = this.offset;
    await this.#write(new Uint8Array(header.buffer));
    await this.#write(nameBytes);
    await this.#write(extra);
    await this.#write(payload);
    this.#entries.push({ nameBytes, crc, method, size, csize, offset });
  }

  /* -------------------------------------------- */

  /**
   * Write the central directory and close the sink.
   */
  async finish() {
    const { time, day } = this.#date;
    const start = this.offset;
    for ( const e of this.#entries ) {
      const big = [];
      if ( e.size >= LIMIT32 ) big.push(e.size);
      if ( e.csize >= LIMIT32 ) big.push(e.csize);
      if ( e.offset >= LIMIT32 ) big.push(e.offset);
      const extra = big.length ? zip64Extra(big) : new Uint8Array(0);
      const version = big.length ? 45 : 20;

      const header = new DataView(new ArrayBuffer(46));
      header.setUint32(0, 0x02014b50, true);
      header.setUint16(4, version, true);
      header.setUint16(6, version, true);
      header.setUint16(8, UTF8_FLAG, true);
      header.setUint16(10, e.method, true);
      header.setUint16(12, time, true);
      header.setUint16(14, day, true);
      header.setUint32(16, e.crc, true);
      header.setUint32(20, cap32(e.csize), true);
      header.setUint32(24, cap32(e.size), true);
      header.setUint16(28, e.nameBytes.length, true);
      header.setUint16(30, extra.length, true);
      // Comment length, disk number, internal and external attributes stay 0.
      header.setUint32(42, cap32(e.offset), true);
      await this.#write(new Uint8Array(header.buffer));
      await this.#write(e.nameBytes);
      await this.#write(extra);
    }
    const size = this.offset - start;
    const count = this.#entries.length;

    if ( (count >= LIMIT16) || (start >= LIMIT32) || (size >= LIMIT32) ) {
      const recordOffset = this.offset;
      const record = new DataView(new ArrayBuffer(56));
      record.setUint32(0, 0x06064b50, true);
      record.setBigUint64(4, 44n, true);
      record.setUint16(12, 45, true);
      record.setUint16(14, 45, true);
      // Disk numbers stay 0.
      record.setBigUint64(24, BigInt(count), true);
      record.setBigUint64(32, BigInt(count), true);
      record.setBigUint64(40, BigInt(size), true);
      record.setBigUint64(48, BigInt(start), true);
      await this.#write(new Uint8Array(record.buffer));

      const locator = new DataView(new ArrayBuffer(20));
      locator.setUint32(0, 0x07064b50, true);
      locator.setBigUint64(8, BigInt(recordOffset), true);
      locator.setUint32(16, 1, true);
      await this.#write(new Uint8Array(locator.buffer));
    }

    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, count >= LIMIT16 ? MAX16 : count, true);
    end.setUint16(10, count >= LIMIT16 ? MAX16 : count, true);
    end.setUint32(12, cap32(size), true);
    end.setUint32(16, cap32(start), true);
    await this.#write(new Uint8Array(end.buffer));
    await this.sink.close();
  }
}

/* -------------------------------------------- */
/*  Sinks                                       */
/* -------------------------------------------- */

/**
 * Where the archive goes. Where the browser can save files directly (Chromium, the Foundry app), the GM picks the
 * file first and the archive is written to disk while it is built. Otherwise the archive is collected in a Blob and
 * downloaded at the end.
 * Must be called from a click handler: the save dialog needs a user gesture.
 * @param {string} filename
 * @returns {Promise<ZipSink & {streamed: boolean}>}  Rejects with an AbortError if the GM cancels the dialog
 */
export async function openSink(filename) {
  if ( typeof window.showSaveFilePicker === "function" ) {
    let handle;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: "ZIP", accept: { "application/zip": [".zip"] } }]
      });
    } catch(err) {
      if ( err.name === "AbortError" ) throw err;
      handle = null; // Not allowed here (e.g. no user gesture left): fall back to a download
    }
    if ( handle ) {
      const stream = await handle.createWritable();
      return {
        streamed: true,
        write: bytes => stream.write(bytes),
        close: () => stream.close(),
        abort: () => stream.abort()
      };
    }
  }
  let parts = [];
  return {
    streamed: false,
    write: async bytes => { parts.push(bytes); },
    close: async () => {
      const blob = new Blob(parts, { type: "application/zip" });
      parts = [];
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    abort: async () => { parts = []; }
  };
}
