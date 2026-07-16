import { sendWebPush } from './webpush.js';
import { makeFirestoreClient } from './firestore.js';
import { occurrencesInRange } from './occurrences.js';

const WINDOW_MS = 6 * 60 * 1000; // cron 每 5 分鐘跑一次,用 6 分鐘視窗確保不漏掉、留一點緩衝

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

    const dueList = [];
    for (const { data: ev } of events) {
      if (ev.deleted || ev.reminder === null || ev.reminder === undefined) continue;
      const occs = occurrencesInRange(ev, rangeStart, rangeEnd);
      for (const occ of occs) {
        const fireAt = occ.start.getTime() - ev.reminder * 60000;
        if (fireAt <= now.getTime() && fireAt > now.getTime() - WINDOW_MS) {
          dueList.push({ ev, occ });
        }
      }
    }
    if (!dueList.length) continue;

    for (const sub of subs) {
      const pushSub = { endpoint: sub.data.endpoint, p256dh: sub.data.p256dh, auth: sub.data.auth };
      for (const { ev, occ } of dueList) {
        const timeStr = ev.allDay
          ? '今天'
          : `${String(occ.start.getHours()).padStart(2, '0')}:${String(occ.start.getMinutes()).padStart(2, '0')}`;
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
    console.log(`群組 ${gid}: ${dueList.length} 筆到期提醒 x ${subs.length} 個訂閱裝置`);
  }
}
