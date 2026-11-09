// Cihazlar arası trafiğin şifrelenmesi. Yalnızca Node'un kendi crypto modülünü kullanır.
//
// - Anahtar eşleşme kodundan scrypt ile türetilir (yavaş olması kod tahminini pahalılaştırır).
// - Her mesaj AES-256-GCM ile mühürlenir: içerik hem gizlenir hem de değiştirilirse fark edilir.
// - Dosyalar 64 KB'lık parçalar hâlinde, aktarıma özel bir anahtarla şifrelenir; parçaların
//   sırası ve dosyanın sonu da doğrulanır (araya girip kesmek ya da yer değiştirmek anlaşılır).
const crypto = require('crypto');
const { Transform } = require('stream');

const CHUNK = 64 * 1024;
const NONCE = 12;
const TAG = 16;
const SALT = 16;
const FRAME_HEAD = 5; // 4 bayt uzunluk + 1 bayt "son parça" işareti

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
  if (sealed.length < TAG) throw new Error('bozuk veri');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
  return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG)), decipher.final()]);
}

// Tek mesaj: [nonce | şifreli içerik | etiket]. `aad` mesajın bağlamıdır; başka bir
// bağlamda (başka istek, başka yol) aynı mesaj açılamaz.
function seal(key, plain, aad) {
  const nonce = crypto.randomBytes(NONCE);
  return Buffer.concat([nonce, encrypt(key, nonce, Buffer.from(plain), aad)]);
}

function open(key, box, aad) {
  if (!Buffer.isBuffer(box) || box.length < NONCE + TAG) throw new Error('bozuk veri');
  return decrypt(key, box.subarray(0, NONCE), box.subarray(NONCE), aad);
}

const fileKey = (key, salt) => Buffer.from(crypto.hkdfSync('sha256', key, salt, 'file', 32));

function frameNonce(index) {
  const nonce = Buffer.alloc(NONCE);
  nonce.writeUInt32BE(index, NONCE - 4);
  return nonce;
}

// Akış biçimi: [16 bayt tuz] sonra parçalar: [uzunluk u32 | son? u8 | şifreli parça + etiket]
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
      // Son parçayı flush'a bırak: hangisinin son olduğu ancak orada bilinir.
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
          if (finished) throw new Error('son parçadan sonra veri');
          const length = buffer.readUInt32BE(0);
          const final = buffer[4] === 1;
          if (length < TAG || length > CHUNK + TAG) throw new Error('bozuk parça');
          if (buffer.length < FRAME_HEAD + length) break;
          const sealed = buffer.subarray(FRAME_HEAD, FRAME_HEAD + length);
          this.push(decrypt(k, frameNonce(index++), sealed, `${aad} ${final ? 1 : 0}`));
          buffer = buffer.subarray(FRAME_HEAD + length);
          finished = final;
        }
        if (finished && buffer.length) throw new Error('son parçadan sonra veri');
        done();
      } catch (err) {
        done(err);
      }
    },
    flush(done) {
      done(finished ? null : new Error('akış yarıda kesildi'));
    },
  });
}

module.exports = { deriveKeys, seal, open, encryptStream, decryptStream };
