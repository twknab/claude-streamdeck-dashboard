// Generates the manifest's required PNG icons with zero dependencies (Node
// builtins only): a dark tile with a centered violet dot. The live key art is
// drawn at runtime via setImage(), so these are just the static/editor icons.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const CRC = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const png = (w, h, draw) => {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = draw(x, y, w, h);
      const o = y * stride + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
};

const BG = [0x17, 0x17, 0x1c, 255];
const ACCENT = [0x8a, 0x63, 0xff, 255];
const tile = (x, y, w, h) => {
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.32;
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r ? ACCENT : BG;
};

const OUT = join(process.cwd(), "com.tknab.claudeagents.sdPlugin");
const jobs = [
  ["imgs/plugin/icon.png", 288, 288], ["imgs/plugin/icon@2x.png", 576, 576],
  ["imgs/category.png", 28, 28], ["imgs/category@2x.png", 56, 56],
  ["imgs/actions/agent/icon.png", 20, 20], ["imgs/actions/agent/icon@2x.png", 40, 40],
  ["imgs/actions/agent/key.png", 72, 72], ["imgs/actions/agent/key@2x.png", 144, 144],
];
for (const [p, w, h] of jobs) {
  const full = join(OUT, p);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, png(w, h, tile));
  console.log("wrote", p, `${w}x${h}`);
}
