// 純 Web Crypto 實作 Web Push(RFC 8291 訊息加密 + RFC 8292 VAPID)。
// 不依賴 web-push npm 套件 —— 它需要 Node 的 crypto.createECDH,
// Cloudflare Workers 的 nodejs_compat 相容層沒有實作這個函式。
// ECDH / HKDF / AES-GCM 都是 Web Crypto 原生支援,不需要任何相容層。

function b64urlDecode(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  const b64 = (str + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function b64urlEncode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concatBytes(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, dataBytes);
  return new Uint8Array(sig);
}

// HKDF-Expand(這裡每次取的長度都 <=32 bytes,只需要一輪)
async function hkdf(salt, ikm, infoBytes, length) {
  const prk = await hmacSha256(salt, ikm);
  const info = concatBytes(infoBytes, new Uint8Array([1]));
  const okm = await hmacSha256(prk, info);
  return okm.slice(0, length);
}

async function vapidAuthHeader(endpoint, vapidPublicKey, vapidPrivateKeyB64, subject) {
  const pubBytes = b64urlDecode(vapidPublicKey);
  const x = pubBytes.slice(1, 33), y = pubBytes.slice(33, 65);
  const d = b64urlDecode(vapidPrivateKeyB64);
  const jwk = {
    kty: 'EC', crv: 'P-256', ext: true,
    x: b64urlEncode(x), y: b64urlEncode(y), d: b64urlEncode(d),
  };
  const privKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);

  const aud = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = { aud, exp: now + 12 * 3600, sub: subject };
  const enc = (obj) => b64urlEncode(new TextEncoder().encode(JSON.stringify(obj)));
  const toSign = `${enc(header)}.${enc(claims)}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privKey, new TextEncoder().encode(toSign));
  const jwt = `${toSign}.${b64urlEncode(new Uint8Array(sig))}`;
  return `vapid t=${jwt}, k=${vapidPublicKey}`;
}

async function encryptPayload(payloadBytes, p256dhB64, authB64) {
  const uaPublicRaw = b64urlDecode(p256dhB64); // 65 bytes
  const authSecret = b64urlDecode(authB64);    // 16 bytes

  const asKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', asKeyPair.publicKey));

  const uaPublicKey = await crypto.subtle.importKey('raw', uaPublicRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPublicKey }, asKeyPair.privateKey, 256)
  );

  const keyInfo = concatBytes(new TextEncoder().encode('WebPush: info\0'), uaPublicRaw, asPublicRaw);
  const ikm = await hkdf(authSecret, sharedSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cekInfo = new TextEncoder().encode('Content-Encoding: aes128gcm\0');
  const nonceInfo = new TextEncoder().encode('Content-Encoding: nonce\0');
  const cek = await hkdf(salt, ikm, cekInfo, 16);
  const nonce = await hkdf(salt, ikm, nonceInfo, 12);

  const padded = concatBytes(payloadBytes, new Uint8Array([2])); // 分隔符,不額外 padding
  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, padded));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  const idLen = new Uint8Array([asPublicRaw.length]);

  return concatBytes(salt, rs, idLen, asPublicRaw, ciphertext);
}

export async function sendWebPush(sub, payloadObj, opts) {
  const { vapidPublicKey, vapidPrivateKey, vapidSubject, ttl = 3600 } = opts;
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payloadObj));
  const body = await encryptPayload(payloadBytes, sub.p256dh, sub.auth);
  const authHeader = await vapidAuthHeader(sub.endpoint, vapidPublicKey, vapidPrivateKey, vapidSubject);

  const resp = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': String(ttl),
      'Authorization': authHeader,
    },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const err = new Error(`推播端點回應 ${resp.status}: ${text}`);
    err.statusCode = resp.status;
    throw err;
  }
  return resp;
}
