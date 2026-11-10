// Browser side of the encryption in src/crypto.js (the "web" variant).
// Plain-HTTP pages on a LAN have no WebCrypto, so AES-GCM comes from @noble/ciphers.
// Takes `gcm` as a parameter so the Node tests can run the exact same code.
const CHUNK = 64 * 1024;
const NONCE = 12;
const TAG = 16;
const SALT = 16;
const FRAME_HEAD = 5;

export function makeWire(gcm, key) {
  const te = new TextEncoder();
  const bytes = (v) => (typeof v === 'string' ? te.encode(v) : v);
  const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
  const base64 = (u8) => btoa(String.fromCharCode(...u8));

  // One message: [nonce | ciphertext | tag], bound to its context `aad`.
  function seal(plain, aad) {
    const nonce = random(NONCE);
    const sealed = gcm(key, nonce, te.encode(aad)).encrypt(bytes(plain));
    const out = new Uint8Array(NONCE + sealed.length);
    out.set(nonce);
    out.set(sealed, NONCE);
    return out;
  }

  function open(box, aad) {
    if (box.length < NONCE + TAG) throw new Error('corrupt data');
    return gcm(key, box.subarray(0, NONCE), te.encode(aad)).decrypt(box.subarray(NONCE));
  }

  // Sealed request header. `nonce` identifies the request; body, response and file are bound to it.
  function header(method, path, meta = {}) {
    const box = seal(JSON.stringify({ ts: Date.now(), ...meta }), `web ${method} ${path}`);
    return { header: base64(box), nonce: hex(box.subarray(0, NONCE)) };
  }

  function frameNonce(prefix, index) {
    const nonce = new Uint8Array(NONCE);
    nonce.set(prefix);
    new DataView(nonce.buffer).setUint32(8, index);
    return nonce;
  }

  // Returns the encrypted stream as a list of parts (pass to `new Blob(parts)`).
  function encryptFile(data, aad) {
    const salt = random(SALT);
    const prefix = salt.subarray(0, 8);
    const parts = [salt];
    let index = 0;
    let offset = 0;
    let final = false;
    while (!final) {
      const end = Math.min(offset + CHUNK, data.length);
      final = end === data.length;
      const sealed = gcm(key, frameNonce(prefix, index++), te.encode(`${aad} ${final ? 1 : 0}`)).encrypt(
        data.subarray(offset, end)
      );
      const head = new Uint8Array(FRAME_HEAD);
      new DataView(head.buffer).setUint32(0, sealed.length);
      head[4] = final ? 1 : 0;
      parts.push(head, sealed);
      offset = end;
    }
    return parts;
  }

  // Returns the decrypted chunks (pass to `new Blob(chunks)`). Throws on any tampering or truncation.
  function decryptFile(data, aad) {
    if (data.length < SALT) throw new Error('stream ended early');
    const prefix = data.subarray(0, 8);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const chunks = [];
    let offset = SALT;
    let index = 0;
    let finished = false;
    while (offset < data.length) {
      if (finished) throw new Error('data after the final chunk');
      if (offset + FRAME_HEAD > data.length) throw new Error('stream ended early');
      const length = view.getUint32(offset);
      const final = data[offset + 4] === 1;
      if (length < TAG || length > CHUNK + TAG) throw new Error('corrupt chunk');
      const start = offset + FRAME_HEAD;
      if (start + length > data.length) throw new Error('stream ended early');
      chunks.push(
        gcm(key, frameNonce(prefix, index++), te.encode(`${aad} ${final ? 1 : 0}`)).decrypt(
          data.subarray(start, start + length)
        )
      );
      offset = start + length;
      finished = final;
    }
    if (!finished) throw new Error('stream ended early');
    return chunks;
  }

  return { seal, open, header, encryptFile, decryptFile };
}
