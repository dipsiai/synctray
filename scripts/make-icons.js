// Generates the tray icons in code (no image tools needed). Run: npm run icons
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shapes in the unit square (0..1): two arrows, one pointing up and one down.
function arrows(u, v) {
  const up = (x, y) =>
    (Math.abs(x - 0.32) <= 0.055 && y >= 0.36 && y <= 0.86) ||
    (y >= 0.12 && y <= 0.42 && Math.abs(x - 0.32) <= (0.19 * (y - 0.12)) / 0.3);
  return up(u, v) || up(1 - u, 1 - v);
}

function roundedSquare(u, v, radius) {
  const dx = Math.max(Math.abs(u - 0.5) - (0.5 - radius), 0);
  const dy = Math.max(Math.abs(v - 0.5) - (0.5 - radius), 0);
  return dx * dx + dy * dy <= radius * radius;
}

// Takes 4x4 samples per pixel for anti-aliasing; returns coverage between 0 and 1.
function coverage(size, x, y, shape) {
  let hits = 0;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      if (shape((x + (i + 0.5) / 4) / size, (y + (j + 0.5) / 4) / size)) hits++;
    }
  }
  return hits / 16;
}

// macOS: black + alpha "template" image; the system tints it for light/dark menu bars.
const template = (size) =>
  png(size, (x, y) => [0, 0, 0, Math.round(255 * coverage(size, x, y, arrows))]);

// Windows: white arrows on a blue tile; readable on light and dark taskbars.
const colored = (size) =>
  png(size, (x, y) => {
    const bg = coverage(size, x, y, (u, v) => roundedSquare(u, v, 0.22));
    const fg = coverage(size, x, y, (u, v) => arrows(0.5 + (u - 0.5) / 0.78, 0.5 + (v - 0.5) / 0.78));
    const mix = (a, b) => Math.round(a + (b - a) * fg);
    return [mix(37, 255), mix(99, 255), mix(235, 255), Math.round(255 * bg)];
  });

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'trayTemplate.png'), template(16));
fs.writeFileSync(path.join(out, 'trayTemplate@2x.png'), template(32));
fs.writeFileSync(path.join(out, 'tray.png'), colored(32));
fs.writeFileSync(path.join(out, 'tray@2x.png'), colored(64));
fs.writeFileSync(path.join(out, 'icon.png'), colored(512));
console.log('icons written →', out);
