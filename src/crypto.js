// Encryption of traffic between devices. Uses only Node's built-in crypto module.
//
// - The key is derived from the pairing code with scrypt (slow on purpose, so guessing codes is costly).
// - Every message is sealed with AES-256-GCM: contents are hidden and any tampering is detected.
// - Files are encrypted in 64 KB chunks with a per-transfer key; chunk order and the end of the
//   file are authenticated too, so cutting a stream short or reordering it is detected.
const crypto = require('crypto');
const { Transform } = require('stream');

const CHUNK = 64 * 1024;
const NONCE = 12;
const TAG = 16;
const SALT = 16;
const FRAME_HEAD = 5; // 4-byte length + 1-byte "last chunk" flag

function deriveKeys(code) {
  const master = crypto.scryptSync(code, 'synctray/v3', 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  const sub = (label) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), label, 32));
  return { enc: sub('enc'), group: sub('group').toString('hex').slice(0, 12) };
}

function encrypt(key, nonce, plain, aad) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function decrypt(key, nonce, sealed, aad) {
  if (sealed.length < TAG) throw new Error('corrupt data');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
  return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG)), decipher.final()]);
}

// One message: [nonce | ciphertext | tag]. `aad` is the message's context; the same message
// cannot be opened in another context (a different request or path).
function seal(key, plain, aad) {
  const nonce = crypto.randomBytes(NONCE);
  return Buffer.concat([nonce, encrypt(key, nonce, Buffer.from(plain), aad)]);
}

function open(key, box, aad) {
  if (!Buffer.isBuffer(box) || box.length < NONCE + TAG) throw new Error('corrupt data');
  return decrypt(key, box.subarray(0, NONCE), box.subarray(NONCE), aad);
}

const fileKey = (key, salt) => Buffer.from(crypto.hkdfSync('sha256', key, salt, 'file', 32));

function frameNonce(index) {
  const nonce = Buffer.alloc(NONCE);
  nonce.writeUInt32BE(index, NONCE - 4);
  return nonce;
}

// Stream format: [16-byte salt] then frames: [length u32 | last? u8 | encrypted chunk + tag]
function encryptStream(key, aad) {
  const salt = crypto.randomBytes(SALT);
  const k = fileKey(key, salt);
  let pending = Buffer.alloc(0);
  let index = 0;
  let started = false;

  const frame = (plain, final) => {
    const sealed = encrypt(k, frameNonce(index++), plain, `${aad} ${final ? 1 : 0}`);
    const head = Buffer.alloc(FRAME_HEAD);
    head.writeUInt32BE(sealed.length, 0);
    head[4] = final ? 1 : 0;
    return Buffer.concat([head, sealed]);
  };

  return new Transform({
    transform(chunk, _enc, done) {
      if (!started) {
        started = true;
        this.push(salt);
      }
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      // Leave the last chunk to flush: only there do we know which one is last.
      while (pending.length > CHUNK) {
        this.push(frame(pending.subarray(0, CHUNK), false));
        pending = pending.subarray(CHUNK);
      }
      done();
    },
    flush(done) {
      if (!started) this.push(salt);
      this.push(frame(pending, true));
      done();
    },
  });
}

function decryptStream(key, aad) {
  let buffer = Buffer.alloc(0);
  let k = null;
  let index = 0;
  let finished = false;

  return new Transform({
    transform(chunk, _enc, done) {
      try {
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
        if (!k) {
          if (buffer.length < SALT) return done();
          k = fileKey(key, buffer.subarray(0, SALT));
          buffer = buffer.subarray(SALT);
        }
        while (buffer.length >= FRAME_HEAD) {
          if (finished) throw new Error('data after the final chunk');
          const length = buffer.readUInt32BE(0);
          const final = buffer[4] === 1;
          if (length < TAG || length > CHUNK + TAG) throw new Error('corrupt chunk');
          if (buffer.length < FRAME_HEAD + length) break;
          const sealed = buffer.subarray(FRAME_HEAD, FRAME_HEAD + length);
          this.push(decrypt(k, frameNonce(index++), sealed, `${aad} ${final ? 1 : 0}`));
          buffer = buffer.subarray(FRAME_HEAD + length);
          finished = final;
        }
        if (finished && buffer.length) throw new Error('data after the final chunk');
        done();
      } catch (err) {
        done(err);
      }
    },
    flush(done) {
      done(finished ? null : new Error('stream ended early'));
    },
  });
}

module.exports = { deriveKeys, seal, open, encryptStream, decryptStream };
