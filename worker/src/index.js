import { sendWebPush } from './webpush.js';
import { makeFirestoreClient } from './firestore.js';
import { occurrencesInRange } from './occurrences.js';

const WINDOW_MS = 6 * 60 * 1000; // cron 每 5 分鐘跑一次,用 6 分鐘視窗確保不漏掉、留一點緩衝(實際去重靠 notifiedReminders,不靠這個視窗)
const timeFmt = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(run(env));
  },
  // 方便手動觸發測試:瀏覽器打開 Worker 網址即可立刻跑一次
  async fetch(_req, env) {
    await run(env);
    return new Response('ok\n');
  },
};

async function run(env) {
  const serviceAccount = JSON.parse(env.GCP_SERVICE_ACCOUNT_JSON);
  const fs = makeFirestoreClient(serviceAccount, env.FIREBASE_PROJECT_ID);

  const now = new Date();
  const rangeStart = new Date(now.getTime() - WINDOW_MS - 24 * 3600000); // 提醒最長可設 1 天前,往前多抓一點確保涵蓋
  const rangeEnd = now;

  const groups = await fs.listDocs('groups');
  console.log(`檢查 ${groups.length} 個群組`);

  for (const group of groups) {
    const gid = group.id;
    let events, subs;
    try {
      [events, subs] = await Promise.all([
        fs.listDocs(`groups/${gid}/events`),
        fs.listDocs(`groups/${gid}/pushSubscriptions`),
      ]);
    } catch (e) {
      console.error(`群組 ${gid} 讀取失敗`, e.message);
      continue;
    }
    if (!subs.length || !events.length) continue;

    // 已發送紀錄(防止同一筆提醒因排程視窗重疊被重複推播兩次以上)
    const notified = await fs.listDocs(`groups/${gid}/notifiedReminders`).catch(() => []);
    const notifiedIds = new Set(notified.map(n => n.id));
    const cutoff = now.getTime() - 48 * 3600000;
    for (const n of notified) {
      if ((n.data.sentAt || 0) < cutoff) await fs.deleteDoc(`groups/${gid}/notifiedReminders/${n.id}`).catch(() => {});
    }

    const dueList = [];
    for (const { id: eventId, data: ev } of events) {
      if (ev.deleted || ev.reminder === null || ev.reminder === undefined) continue;
      const occs = occurrencesInRange(ev, rangeStart, rangeEnd);
      for (const occ of occs) {
        const fireAt = occ.start.getTime() - ev.reminder * 60000;
        if (fireAt <= now.getTime() && fireAt > now.getTime() - WINDOW_MS) {
          const key = `${eventId}_${occ.start.getTime()}`;
          if (notifiedIds.has(key)) continue; // 這筆提醒已經送過了,跳過
          dueList.push({ ev, occ, key });
        }
      }
    }
    if (!dueList.length) continue;

    for (const sub of subs) {
      const pushSub = { endpoint: sub.data.endpoint, p256dh: sub.data.p256dh, auth: sub.data.auth };
      for (const { ev, occ } of dueList) {
        const timeStr = ev.allDay ? '今天' : timeFmt.format(occ.start);
        try {
          await sendWebPush(
            pushSub,
            { title: '📅 ' + ev.title, body: timeStr },
            { vapidPublicKey: env.VAPID_PUBLIC_KEY, vapidPrivateKey: env.VAPID_PRIVATE_KEY, vapidSubject: env.VAPID_SUBJECT, ttl: 3600 }
          );
          console.log('推播成功', sub.id, ev.title);
        } catch (e) {
          console.error('推播失敗', sub.id, 'statusCode=', e.statusCode, 'message=', e.message);
          if (e.statusCode === 404 || e.statusCode === 410) {
            // 訂閱失效(裝置解除安裝/清除資料)→ 清掉,避免下次繼續打失敗
            await fs.deleteDoc(`groups/${gid}/pushSubscriptions/${sub.id}`).catch(() => {});
          }
        }
      }
    }

    // 不論每個裝置發送成功與否,整批標記為已處理,避免視窗重疊或個別裝置失敗造成重試風暴
    for (const { key } of dueList) {
      await fs.putDoc(`groups/${gid}/notifiedReminders/${key}`, { sentAt: now.getTime() }).catch(() => {});
    }
    console.log(`群組 ${gid}: ${dueList.length} 筆到期提醒 x ${subs.length} 個訂閱裝置`);
  }
}
