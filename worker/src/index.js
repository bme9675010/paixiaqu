import { sendWebPush } from './webpush.js';
import { makeFirestoreClient } from './firestore.js';
import { occurrencesInRange } from './occurrences.js';

const WINDOW_MS = 6 * 60 * 1000; // cron 每 5 分鐘跑一次,用 6 分鐘視窗確保不漏掉、留一點緩衝(實際去重靠 notifiedReminders,不靠這個視窗)
const timeFmt = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(run(env));
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
    if (req.method === 'POST' && url.pathname === '/notify') {
      const resp = await handleNotify(req, env);
      for (const [k, v] of Object.entries(CORS_HEADERS)) resp.headers.set(k, v);
      return resp;
    }
    // 方便手動觸發測試:瀏覽器打開 Worker 網址即可立刻跑一次提醒檢查
    await run(env);
    return new Response('ok\n');
  },
};

// 有人在 App 裡新增/修改行程時,前端會呼叫這個端點,立即通知群組裡「除了自己以外」的其他裝置
// (跟提醒推播是分開的機制:提醒是排程到期才發,這個是動作發生當下就發)
async function handleNotify(req, env) {
  let body;
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
  const { groupId, excludeUid, title, text } = body || {};
  if (!groupId || !title || !text) return new Response('missing fields', { status: 400 });

  const serviceAccount = JSON.parse(env.GCP_SERVICE_ACCOUNT_JSON);
  const fs = makeFirestoreClient(serviceAccount, env.FIREBASE_PROJECT_ID);
  const subs = await fs.listDocs(`groups/${groupId}/pushSubscriptions`).catch(() => []);

  let sent = 0;
  for (const sub of subs) {
    if (excludeUid && sub.id === excludeUid) continue;
    const pushSub = { endpoint: sub.data.endpoint, p256dh: sub.data.p256dh, auth: sub.data.auth };
    try {
      await sendWebPush(
        pushSub,
        { title, body: text },
        { vapidPublicKey: env.VAPID_PUBLIC_KEY, vapidPrivateKey: env.VAPID_PRIVATE_KEY, vapidSubject: env.VAPID_SUBJECT, ttl: 3600 }
      );
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        await fs.deleteDoc(`groups/${groupId}/pushSubscriptions/${sub.id}`).catch(() => {});
      }
    }
  }
  return new Response(JSON.stringify({ sent }), { headers: { 'Content-Type': 'application/json' } });
}

// 群組行程/訂閱快取存在 KV:只有群組 lastChangeMs 變了(App 有人改資料)才重新向 Firestore 讀取,
// 否則每 5 分鐘的檢查只花 1 次讀取(列出群組)。Firestore 免費額度是每天 5 萬次讀取,照筆數計。
const CACHE_MAX_AGE_MS = 30 * 60 * 1000; // 保險:就算沒偵測到變動,30 分鐘也強制重讀一次(相容還沒更新的舊版 App)

async function loadGroupData(env, fs, gid, lastChangeMs, nowMs) {
  const key = `group:${gid}`;
  if (env.CACHE) {
    const cached = await env.CACHE.get(key, 'json').catch(() => null);
    if (cached && cached.lastChangeMs === lastChangeMs && nowMs - cached.fetchedAt < CACHE_MAX_AGE_MS) {
      return { ...cached, fromCache: true };
    }
  }
  const [events, subs] = await Promise.all([
    fs.listDocs(`groups/${gid}/events`),
    fs.listDocs(`groups/${gid}/pushSubscriptions`),
  ]);
  // 只留算提醒需要的行程(沒刪除、有設提醒),縮小快取
  const slim = events.filter(e => !e.data.deleted && (e.data.reminder != null || e.data.reminder2 != null));
  const data = { lastChangeMs, fetchedAt: nowMs, events: slim, subs };
  if (env.CACHE) await env.CACHE.put(key, JSON.stringify(data)).catch(e => console.warn('寫入快取失敗', e.message));
  return { ...data, fromCache: false };
}

// Worker 執行環境是 UTC,但重複規則(星期幾、整天、例外日期、重複結束日)要用台灣時間判斷。
// 台灣沒有日光節約,所以把時間平移 +8 小時,用 UTC 當作台灣時間計算,算完再平移回來。
const TPE_OFFSET = 8 * 3600000;
function occurrencesInTaipei(ev, rangeStart, rangeEnd) {
  const shifted = { ...ev, startAt: ev.startAt + TPE_OFFSET, endAt: ev.endAt + TPE_OFFSET };
  return occurrencesInRange(shifted, new Date(rangeStart.getTime() + TPE_OFFSET), new Date(rangeEnd.getTime() + TPE_OFFSET))
    .map(o => ({ start: new Date(o.start.getTime() - TPE_OFFSET), end: new Date(o.end.getTime() - TPE_OFFSET) }));
}

async function run(env) {
  const serviceAccount = JSON.parse(env.GCP_SERVICE_ACCOUNT_JSON);
  const fs = makeFirestoreClient(serviceAccount, env.FIREBASE_PROJECT_ID);

  const now = new Date();
  const nowMs = now.getTime();
  // 要找「提醒時間落在現在附近」的行程:提醒最早可設 1 週前 → 往後看 8 天;
  // 整天行程可設「當天幾點」提醒(此時行程已開始)→ 往前看 1 天。
  // (舊版把範圍設成「過去 24 小時~現在」,方向反了,導致只有「準時」提醒會發)
  const rangeStart = new Date(nowMs - WINDOW_MS - 24 * 3600000);
  const rangeEnd = new Date(nowMs + 8 * 24 * 3600000);

  const groups = await fs.listDocs('groups');
  console.log(`檢查 ${groups.length} 個群組`);

  for (const group of groups) {
    const gid = group.id;
    let events, subs, fromCache;
    try {
      ({ events, subs, fromCache } = await loadGroupData(env, fs, gid, group.data.lastChangeMs || 0, nowMs));
    } catch (e) {
      console.error(`群組 ${gid} 讀取失敗`, e.message);
      continue;
    }
    if (!subs.length || !events.length) continue;

    const dueList = [];
    for (const { id: eventId, data: ev } of events) {
      if (ev.deleted) continue;
      const slots = [['reminder', ev.reminder], ['reminder2', ev.reminder2]]
        .filter(([, mins]) => mins !== null && mins !== undefined);
      if (!slots.length) continue;
      const occs = occurrencesInTaipei(ev, rangeStart, rangeEnd);
      for (const occ of occs) {
        for (const [slotName, mins] of slots) {
          const fireAt = occ.start.getTime() - mins * 60000;
          if (fireAt <= nowMs && fireAt > nowMs - WINDOW_MS) {
            dueList.push({ ev, occ, key: `${eventId}_${occ.start.getTime()}_${slotName}` });
          }
        }
      }
    }
    if (!dueList.length) continue;

    // 有到期提醒才去讀「已發送紀錄」(防止同一筆提醒因排程視窗重疊被重複推播)
    const notified = await fs.listDocs(`groups/${gid}/notifiedReminders`).catch(() => []);
    const notifiedIds = new Set(notified.map(n => n.id));
    const cutoff = nowMs - 48 * 3600000;
    for (const n of notified) {
      if ((n.data.sentAt || 0) < cutoff) await fs.deleteDoc(`groups/${gid}/notifiedReminders/${n.id}`).catch(() => {});
    }
    const toSend = dueList.filter(d => !notifiedIds.has(d.key));
    if (!toSend.length) continue;

    let subsChanged = false;
    for (const sub of subs) {
      const pushSub = { endpoint: sub.data.endpoint, p256dh: sub.data.p256dh, auth: sub.data.auth };
      for (const { ev, occ } of toSend) {
        const timeStr = ev.allDay ? '今天' : timeFmt.format(occ.start);
        const payload = { title: '📅 ' + ev.title, body: timeStr };
        try {
          await sendWebPush(
            pushSub,
            payload,
            { vapidPublicKey: env.VAPID_PUBLIC_KEY, vapidPrivateKey: env.VAPID_PRIVATE_KEY, vapidSubject: env.VAPID_SUBJECT, ttl: 3600 }
          );
          console.log('推播成功', sub.id, ev.title);
        } catch (e) {
          console.error('推播失敗', sub.id, 'statusCode=', e.statusCode, 'message=', e.message);
          if (e.statusCode === 404 || e.statusCode === 410) {
            // 訂閱失效(裝置解除安裝/清除資料)→ 清掉,避免下次繼續打失敗
            await fs.deleteDoc(`groups/${gid}/pushSubscriptions/${sub.id}`).catch(() => {});
            subsChanged = true;
            break;
          }
        }
      }
    }
    if (subsChanged && env.CACHE) await env.CACHE.delete(`group:${gid}`).catch(() => {});

    // 不論每個裝置發送成功與否,整批標記為已處理,避免視窗重疊或個別裝置失敗造成重試風暴
    for (const { key } of toSend) {
      await fs.putDoc(`groups/${gid}/notifiedReminders/${key}`, { sentAt: nowMs }).catch(() => {});
    }
    console.log(`群組 ${gid}: ${toSend.length} 筆到期提醒 x ${subs.length} 個訂閱裝置${fromCache ? '(快取)' : ''}`);
  }
}
