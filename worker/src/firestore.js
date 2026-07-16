// 用 GCP 服務帳戶(Service Account)存取 Firestore REST API。
// 只用 Web Crypto(RSASSA-PKCS1-v1_5 / RS256)簽 JWT 換 Google OAuth2 access token,
// 不依賴任何 Node-only 套件,Cloudflare Workers 原生支援。

function b64url(bytes) {
  let bin = '';
  const arr = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlJson(obj) {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

function pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

let cachedToken = null; // { token, exp }

async function getAccessToken(serviceAccount) {
  if (cachedToken && cachedToken.exp > Date.now() / 1000 + 60) return cachedToken.token;

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const toSign = `${b64urlJson(header)}.${b64urlJson(claims)}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(serviceAccount.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(toSign));
  const jwt = `${toSign}.${b64url(sig)}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!resp.ok) throw new Error('取得 Google access token 失敗: ' + await resp.text());
  const data = await resp.json();
  cachedToken = { token: data.access_token, exp: now + data.expires_in };
  return cachedToken.token;
}

// Firestore REST 文件物件 <-> 一般 JS 物件 的簡易轉換(只處理本專案會用到的型別)
function decodeValue(v) {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.nullValue !== undefined) return null;
  if (v.arrayValue !== undefined) return (v.arrayValue.values || []).map(decodeValue);
  if (v.mapValue !== undefined) return decodeFields(v.mapValue.fields || {});
  return null;
}
function decodeFields(fields) {
  const out = {};
  for (const k of Object.keys(fields)) out[k] = decodeValue(fields[k]);
  return out;
}

export function makeFirestoreClient(serviceAccount, projectId) {
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

  async function authedFetch(url, opts = {}) {
    const token = await getAccessToken(serviceAccount);
    const resp = await fetch(url, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` },
    });
    return resp;
  }

  return {
    // 列出某個 collection 底下所有文件(自動翻頁),回傳 [{id, data}]
    async listDocs(path) {
      const out = [];
      let pageToken = '';
      do {
        const url = `${base}/${path}?pageSize=300${pageToken ? '&pageToken=' + pageToken : ''}`;
        const resp = await authedFetch(url);
        if (resp.status === 404) return out; // collection 不存在(空群組)
        if (!resp.ok) throw new Error(`listDocs ${path} 失敗: ${await resp.text()}`);
        const data = await resp.json();
        for (const d of (data.documents || [])) {
          out.push({ id: d.name.split('/').pop(), data: decodeFields(d.fields || {}) });
        }
        pageToken = data.nextPageToken || '';
      } while (pageToken);
      return out;
    },

    async deleteDoc(path) {
      const resp = await authedFetch(`${base}/${path}`, { method: 'DELETE' });
      if (!resp.ok && resp.status !== 404) throw new Error(`deleteDoc ${path} 失敗: ${await resp.text()}`);
    },
  };
}
