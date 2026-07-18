import fs from 'fs';

const serviceAccount = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));
const projectId = serviceAccount.project_id;
const rulesContent = fs.readFileSync('../firebase/firestore.rules', 'utf8');

function b64url(bytes) { let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return Buffer.from(bin, 'binary').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlJson(o) { return b64url(Buffer.from(JSON.stringify(o))); }
function pemToArrayBuffer(pem) { const b64 = pem.replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '').replace(/\s+/g, ''); return Buffer.from(b64, 'base64'); }

async function getToken(scope) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = { iss: serviceAccount.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const toSign = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const key = await crypto.subtle.importKey('pkcs8', pemToArrayBuffer(serviceAccount.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(toSign));
  const jwt = `${toSign}.${b64url(new Uint8Array(sig))}`;
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(JSON.stringify(data));
  return data.access_token;
}

const token = await getToken('https://www.googleapis.com/auth/cloud-platform');

// 1. 建立新的 ruleset
const createResp = await fetch(`https://firebaserules.googleapis.com/v1/projects/${projectId}/rulesets`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ source: { files: [{ name: 'firestore.rules', content: rulesContent }] } }),
});
const created = await createResp.json();
if (!createResp.ok) { console.error('建立 ruleset 失敗', created); process.exit(1); }
console.log('新 ruleset:', created.name);

// 2. 更新 release,指向新 ruleset
const releaseResp = await fetch(`https://firebaserules.googleapis.com/v1/projects/${projectId}/releases/cloud.firestore`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ release: { name: `projects/${projectId}/releases/cloud.firestore`, rulesetName: created.name } }),
});
const released = await releaseResp.json();
if (!releaseResp.ok) { console.error('發布規則失敗', released); process.exit(1); }
console.log('規則發布成功!rulesetName =', released.rulesetName);
