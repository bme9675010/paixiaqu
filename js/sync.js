// 雲端同步 (Firebase Firestore) — 家人共享行事曆
// 未設定 config.js 的 Firebase 金鑰時,App 以純本地模式運作。
import { db } from './db.js';

const SDK_VER = '10.12.2';
export const PHOTO_MAX_BASE64 = 900000; // Firestore 單一文件上限 1MiB,照片留安全邊界

let fb = null; // { auth, fs, uid, mods:{...firestore funcs} }
let groupId = null;
let onRemoteChange = null;
let toast = () => {};
let unsubEvents = null, unsubCalendars = null, unsubTodos = null, unsubTags = null, unsubMembers = null;
let memberNames = {}; // uid -> 暱稱 快取
let bumpTimer = null;

const $ = id => document.getElementById(id);

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

function configured() {
  const c = window.APP_CONFIG || {};
  return !!(c.FIREBASE_API_KEY && c.FIREBASE_PROJECT_ID)
    && !String(c.FIREBASE_API_KEY).includes('你的');
}

async function loadFirebase() {
  const [{ initializeApp }, authMod, fsMod] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${SDK_VER}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${SDK_VER}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${SDK_VER}/firebase-firestore.js`),
  ]);
  const c = window.APP_CONFIG;
  const app = initializeApp({
    apiKey: c.FIREBASE_API_KEY,
    authDomain: c.FIREBASE_AUTH_DOMAIN || `${c.FIREBASE_PROJECT_ID}.firebaseapp.com`,
    projectId: c.FIREBASE_PROJECT_ID,
    appId: c.FIREBASE_APP_ID,
  });
  const auth = authMod.getAuth(app);
  const fs = fsMod.getFirestore(app);
  return { auth, fs, authMod, fsMod };
}

export const sync = {
  async init(opts) {
    onRemoteChange = opts.onRemoteChange;
    toast = opts.toast;
    if (!configured()) return;
    try {
      const { auth, fs, authMod, fsMod } = await loadFirebase();
      let user = auth.currentUser;
      if (!user) {
        const cred = await authMod.signInAnonymously(auth);
        user = cred.user;
      }
      fb = { auth, fs, uid: user.uid, m: { ...authMod, ...fsMod } };
      memberNames = (await db.getMeta('memberNames')) || {};
      groupId = await db.getMeta('groupId');
      if (groupId) {
        // 不再先整包 pullAll:即時監聽的第一次快照就是完整資料,省一半讀取量
        this.subscribe();
        if ('Notification' in window && Notification.permission === 'granted') this.subscribePush();
      }
      this.renderStatus();
    } catch (e) {
      console.warn('同步初始化失敗', e);
    }
  },

  renderStatus() {
    const statusEl = $('syncStatus');
    const controlsEl = $('syncControls');
    if (!statusEl) return;
    if (!configured()) {
      statusEl.hidden = false;
      controlsEl.hidden = true;
      return;
    }
    statusEl.hidden = true;
    controlsEl.hidden = false;
    db.getMeta('groupCode').then(code => {
      db.getMeta('memberName').then(name => {
        if (name) $('syncName').value = name;
        if (!groupId) {
          $('groupInfo').innerHTML = '尚未加入群組。建立一個新群組,或輸入家人給你的邀請碼。';
          return;
        }
        const joinUrl = `${location.origin}${location.pathname}?join=${code || ''}`;
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(joinUrl)}`;
        $('groupInfo').innerHTML = `✅ 已加入家庭群組<br>邀請碼:<b style="font-size:18px;letter-spacing:2px">${code || ''}</b><br>把邀請碼給家人,他們在自己手機的 App 輸入即可共享。
          <div style="margin-top:10px;display:flex;flex-direction:column;align-items:center;gap:8px">
            <img src="${qrUrl}" width="140" height="140" style="border-radius:8px;background:#fff" alt="邀請 QR code">
            <button class="outline-btn" id="btnShareInvite" style="width:100%">📤 分享邀請連結</button>
          </div>`;
        $('btnShareInvite').onclick = async () => {
          if (navigator.share) {
            try { await navigator.share({ title: '排下去 家庭共享邀請', text: `邀請你加入我的排下去家庭行事曆,邀請碼:${code}`, url: joinUrl }); }
            catch { /* 使用者取消分享,不用處理 */ }
          } else {
            try { await navigator.clipboard.writeText(joinUrl); toast('邀請連結已複製'); }
            catch { toast(joinUrl); }
          }
        };
      });
    });
    $('btnCreateGroup').onclick = () => this.createGroup();
    $('btnJoinGroup').onclick = () => this.joinGroup($('joinCode').value.trim());
    $('syncName').onchange = () => db.setMeta('memberName', $('syncName').value.trim());
    $('btnManualSync').hidden = !groupId;
    $('btnManualSync').onclick = async () => {
      $('btnManualSync').disabled = true;
      await this.manualSync();
      $('btnManualSync').disabled = false;
      toast('已同步最新資料 ✅');
    };
  },

  async manualSync() {
    if (!fb || !groupId) return;
    await this.pullAll();
    if (onRemoteChange) onRemoteChange();
  },

  async createGroup() {
    if (!fb) return;
    try {
      const { doc, setDoc, collection, getDocs, query, where } = fb.m;
      let code;
      // 隨機碼避免與現有群組撞號
      for (let i = 0; i < 5; i++) {
        code = Math.random().toString(36).slice(2, 8).toUpperCase();
        const snap = await getDocs(query(collection(fb.fs, 'groups'), where('inviteCode', '==', code)));
        if (snap.empty) break;
      }
      const ref = doc(collection(fb.fs, 'groups'));
      await setDoc(ref, { inviteCode: code, name: '我的家庭', createdAt: Date.now() });
      await this._joined(ref.id, code, false);
      toast('群組建立成功 🎉');
    } catch (e) { toast('建立失敗:' + e.message); }
  },

  async joinGroup(code) {
    if (!fb || !code) { toast('請輸入邀請碼'); return; }
    try {
      const { collection, query, where, getDocs } = fb.m;
      const snap = await getDocs(query(collection(fb.fs, 'groups'), where('inviteCode', '==', code.toUpperCase())));
      if (snap.empty) throw new Error('找不到這個邀請碼');
      const d = snap.docs[0];
      await this._joined(d.id, d.data().inviteCode, true);
      toast('加入成功 🎉');
    } catch (e) { toast('加入失敗:' + e.message); }
  },

  async _joined(gid, code, isJoin) {
    groupId = gid;
    await db.setMeta('groupId', gid);
    await db.setMeta('groupCode', code);
    const { doc, setDoc } = fb.m;
    await setDoc(doc(fb.fs, 'groups', gid, 'members', fb.uid), {
      name: (await db.getMeta('memberName')) || '家人', joinedAt: Date.now(),
    });

    if (isJoin) {
      // 加入既有群組:先記住加入前本機的行事曆/行程,拉完雲端資料後
      // 把「本機自動建立、從未使用過」的預設行事曆(家庭/工作/個人)直接丟棄,
      // 避免跟群組既有的預設行事曆重複;真的有用到的資料才推上雲端保留。
      const DEFAULT_NAMES = ['家庭', '工作', '個人'];
      const preJoinCals = await db.getAll('calendars');
      const preJoinCalIds = new Set(preJoinCals.filter(c => !c.deleted).map(c => c.id));
      const preJoinEvents = await db.getAll('events');
      const usedCalIds = new Set(preJoinEvents.filter(e => !e.deleted).map(e => e.calendarId));

      await this.pullAll();

      for (const c of preJoinCals) {
        if (!c.deleted && DEFAULT_NAMES.includes(c.name) && !usedCalIds.has(c.id)) {
          await db.del('calendars', c.id);
        }
      }
      const stillLocalCals = (await db.getAll('calendars')).filter(c => preJoinCalIds.has(c.id) && !c.deleted);
      for (const c of stillLocalCals) await this.pushCalendar(c);
      for (const e of preJoinEvents) if (!e.deleted) await this.pushEvent(e);
      const preJoinTodos = await db.getAll('todos');
      for (const t of preJoinTodos) if (!t.deleted) await this.pushTodo(t);
    } else {
      // 建立新群組:本機既有資料就是這個群組的初始資料
      const cals = await db.getAll('calendars');
      const evs = await db.getAll('events');
      const tds = await db.getAll('todos');
      for (const c of cals) await this.pushCalendar(c);
      for (const e of evs) await this.pushEvent(e);
      for (const t of tds) await this.pushTodo(t);
    }

    this.subscribe(); // 監聽的第一次快照會帶回完整雲端資料,不用再另外 pullAll
    this.renderStatus();
    if ('Notification' in window && Notification.permission === 'granted') this.subscribePush();
    if (onRemoteChange) onRemoteChange();
  },

  // 訂閱雲端推播(App 沒開也會通知);需要已授權通知權限 + 已設定 VAPID 金鑰 + 已加入群組
  // verbose=true 時,失敗原因會用 toast 顯示出來(從設定頁按鈕手動觸發時用,方便回報問題)
  async subscribePush(verbose) {
    const say = (msg) => { console.warn(msg); if (verbose) toast(msg); };
    if (!fb || !groupId) { if (verbose) say('尚未加入家庭群組,無法訂閱雲端推播'); return; }
    const c = window.APP_CONFIG || {};
    if (!c.VAPID_PUBLIC_KEY) { say('未設定 VAPID 金鑰'); return; }
    if (!('serviceWorker' in navigator)) { say('此瀏覽器不支援 Service Worker'); return; }
    if (!('PushManager' in window)) { say('此瀏覽器/情境不支援推播(iPhone 請確認是從主畫面圖示開啟 App,不是 Safari 分頁)'); return; }
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(c.VAPID_PUBLIC_KEY),
        });
      }
      const json = sub.toJSON();
      // 每次開 App 都會跑到這裡;訂閱沒變就不用重寫(也不用讓 Worker 的快取失效)
      const savedKey = `${groupId}|${json.endpoint}`;
      if (!verbose && (await db.getMeta('pushSubSaved')) === savedKey) return;
      const { doc, setDoc } = fb.m;
      await setDoc(doc(fb.fs, 'groups', groupId, 'pushSubscriptions', fb.uid), {
        endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth, updatedAt: Date.now(),
      });
      await db.setMeta('pushSubSaved', savedKey);
      this.bumpChange();
      if (verbose) toast('雲端推播訂閱成功 ✅');
    } catch (e) { say('推播訂閱失敗:' + (e.message || e)); }
  },

  // 雲端推播是否已經接管提醒(此時本機不該再自己跳一次,避免重複通知)
  cloudPushActive() {
    const c = window.APP_CONFIG || {};
    return !!(fb && groupId && c.VAPID_PUBLIC_KEY && 'Notification' in window && Notification.permission === 'granted');
  },

  // 是否已加入家人共享(建立者/參加者/留言 這些功能都要靠這個)
  cloudActive() { return !!(fb && groupId); },
  getUid() { return fb ? fb.uid : null; },
  getMemberName(uid) { return memberNames[uid] || '家人'; },

  // 在群組文件上記一個「最後變動時間」,推播 Worker 每 5 分鐘只看這個欄位,
  // 有變才重讀全部行程,沒變就用快取,省下大量讀取額度。短時間連續變動(例如匯入)合併成一次寫入。
  bumpChange() {
    if (!fb || !groupId) return;
    clearTimeout(bumpTimer);
    bumpTimer = setTimeout(async () => {
      try {
        const { doc, updateDoc } = fb.m;
        await updateDoc(doc(fb.fs, 'groups', groupId), { lastChangeMs: Date.now() });
      } catch (e) { console.warn('更新群組變動時間失敗', e); }
    }, 1500);
  },

  // 有人新增/修改行程時立即通知群組裡的其他人(跟到期提醒是不同機制,不用等提醒時間)
  async notifyGroup(title, text) {
    if (!fb || !groupId) return;
    const c = window.APP_CONFIG || {};
    if (!c.WORKER_URL) return;
    try {
      await fetch(`${c.WORKER_URL}/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId, excludeUid: fb.uid, title, text }),
      });
    } catch (e) { console.warn('即時通知發送失敗', e); }
  },

  async pushCalendar(cal) {
    if (!fb || !groupId) return;
    try {
      const { doc, setDoc } = fb.m;
      await setDoc(doc(fb.fs, 'groups', groupId, 'calendars', cal.id), {
        name: cal.name, color: cal.color, deleted: !!cal.deleted, updatedAtMs: cal.updatedAt,
      });
    } catch (e) { console.warn('push calendar 失敗', e); }
  },

  async pushPersonTag(t) {
    if (!fb || !groupId) return;
    try {
      const { doc, setDoc } = fb.m;
      await setDoc(doc(fb.fs, 'groups', groupId, 'personTags', t.id), {
        name: t.name, color: t.color, deleted: !!t.deleted, updatedAtMs: t.updatedAt,
      });
    } catch (e) { console.warn('push person tag 失敗', e); }
  },

  async pushEvent(ev) {
    if (!fb || !groupId) return;
    try {
      const { doc, setDoc } = fb.m;
      // 照片直接存進 Firestore(base64),避免需要開通付費的 Storage
      for (const pid of (ev.photos || [])) {
        const p = await db.get('photos', pid);
        if (!p || p.synced) continue;
        if (p.data.length > PHOTO_MAX_BASE64) { console.warn('附件太大,略過雲端同步:', pid); continue; }
        await setDoc(doc(fb.fs, 'groups', groupId, 'photos', pid), {
          data: p.data, name: p.name || '', type: p.type || '', updatedAtMs: p.updatedAt || Date.now(),
        });
        p.synced = true;
        await db.put('photos', p);
      }
      await setDoc(doc(fb.fs, 'groups', groupId, 'events', ev.id), {
        calendarId: ev.calendarId, title: ev.title, allDay: ev.allDay,
        startAt: ev.start, endAt: ev.end,
        repeat: ev.repeat || 'none', repeatUntil: ev.repeatUntil || null, exdates: ev.exdates || [],
        interval: ev.interval || null, byDay: ev.byDay || null,
        reminder: ev.reminder, reminder2: ev.reminder2 ?? null, color: ev.color || null, tagIds: ev.tagIds || [], location: ev.location || '', url: ev.url || '', notes: ev.notes || '',
        photoIds: ev.photos || [],
        createdBy: ev.createdBy || fb.uid, attendees: ev.attendees || [],
        deleted: !!ev.deleted, updatedAtMs: ev.updatedAt,
      });
      this.bumpChange();
    } catch (e) { console.warn('push event 失敗', e); }
  },

  async pushTodo(t) {
    if (!fb || !groupId) return;
    try {
      const { doc, setDoc } = fb.m;
      await setDoc(doc(fb.fs, 'groups', groupId, 'todos', t.id), {
        text: t.text, done: !!t.done, deleted: !!t.deleted, updatedAtMs: t.updatedAt,
      });
    } catch (e) { console.warn('push todo 失敗', e); }
  },

  // 行程留言:即時監聽,不落地存本機(需要即時線上才看得到,離線時空白)
  listenComments(eventId, cb) {
    if (!fb || !groupId) { cb([]); return () => {}; }
    const { collection, query, orderBy, onSnapshot } = fb.m;
    const q = query(collection(fb.fs, 'groups', groupId, 'events', eventId, 'comments'), orderBy('createdAt', 'asc'));
    return onSnapshot(q, snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))), () => cb([]));
  },
  // image:壓縮過的照片 data URL(可省略),直接存在留言文件裡
  async postComment(eventId, text, image = null) {
    if (!fb || !groupId) return;
    const { doc, collection, setDoc } = fb.m;
    const name = (await db.getMeta('memberName')) || '家人';
    const ref = doc(collection(fb.fs, 'groups', groupId, 'events', eventId, 'comments'));
    const data = { uid: fb.uid, name, text: text || '', createdAt: Date.now() };
    if (image) data.image = image;
    await setDoc(ref, data);
  },
  async deleteComment(eventId, commentId) {
    if (!fb || !groupId) return;
    const { doc, deleteDoc } = fb.m;
    await deleteDoc(doc(fb.fs, 'groups', groupId, 'events', eventId, 'comments', commentId));
  },

  // ── 把雲端的一筆文件套用到本機(以 updatedAt 較新者為準),pullAll 和即時監聽共用 ──
  async _applyCalendar(d) {
    const rc = d.data();
    const local = await db.get('calendars', d.id);
    if (!local || rc.updatedAtMs > local.updatedAt) {
      await db.put('calendars', {
        id: d.id, name: rc.name, color: rc.color,
        hidden: local ? local.hidden : false,
        deleted: rc.deleted, updatedAt: rc.updatedAtMs,
      });
      return true;
    }
    return false;
  },
  async _applyEvent(d) {
    const re = d.data();
    const local = await db.get('events', d.id);
    if (local && !(re.updatedAtMs > local.updatedAt)) return false;
    const { doc, getDoc } = fb.m;
    const photoIds = re.photoIds || [];
    for (const pid of photoIds) {
      if (await db.get('photos', pid)) continue;
      try {
        const pSnap = await getDoc(doc(fb.fs, 'groups', groupId, 'photos', pid));
        if (pSnap.exists()) {
          const pd = pSnap.data();
          await db.put('photos', { id: pid, data: pd.data, name: pd.name || '', type: pd.type || '', synced: true, updatedAt: Date.now() });
        }
      } catch { /* 附件抓不到就略過 */ }
    }
    await db.put('events', {
      id: d.id, calendarId: re.calendarId, title: re.title,
      allDay: re.allDay, start: re.startAt, end: re.endAt,
      repeat: re.repeat, repeatUntil: re.repeatUntil || null, exdates: re.exdates || [], interval: re.interval || null, byDay: re.byDay || null, reminder: re.reminder, reminder2: re.reminder2 ?? null, color: re.color || null, tagIds: re.tagIds || [], location: re.location || '', url: re.url || '', notes: re.notes,
      photos: photoIds, createdBy: re.createdBy || null, attendees: re.attendees || [],
      deleted: re.deleted, updatedAt: re.updatedAtMs,
    });
    return true;
  },
  async _applyTodo(d) {
    const rt = d.data();
    const local = await db.get('todos', d.id);
    if (!local || rt.updatedAtMs > local.updatedAt) {
      await db.put('todos', { id: d.id, text: rt.text, done: rt.done, deleted: rt.deleted, updatedAt: rt.updatedAtMs });
      return true;
    }
    return false;
  },
  async _applyTag(d) {
    const rt = d.data();
    const local = await db.get('personTags', d.id);
    if (!local || rt.updatedAtMs > local.updatedAt) {
      await db.put('personTags', { id: d.id, name: rt.name, color: rt.color, deleted: rt.deleted, updatedAt: rt.updatedAtMs });
      return true;
    }
    return false;
  },
  async _applyMembers(docs) {
    for (const d of docs) memberNames[d.id] = d.data().name || '家人';
    await db.setMeta('memberNames', memberNames);
  },

  // 從雲端拉全部資料(只用在加入群組、手動「立即同步」這種少見情況;平常靠下面的即時監聽,只讀有變動的那幾筆)
  async pullAll() {
    if (!fb || !groupId) return;
    try {
      const { collection, getDocs } = fb.m;
      const col = (name) => getDocs(collection(fb.fs, 'groups', groupId, name));
      for (const d of (await col('calendars')).docs) await this._applyCalendar(d);
      for (const d of (await col('events')).docs) await this._applyEvent(d);
      memberNames = {};
      await this._applyMembers((await col('members')).docs);
      for (const d of (await col('todos')).docs) await this._applyTodo(d);
      for (const d of (await col('personTags')).docs) await this._applyTag(d);
    } catch (e) { console.warn('pull 失敗', e); }
  },

  // 即時訂閱:第一次會收到整包資料(取代開 App 時的 pullAll),之後只會收到「有變動的那幾筆」,
  // 只套用那幾筆就好,不再整包重讀 — Firestore 讀取額度是照筆數算的,這是省額度的關鍵。
  subscribe() {
    if (!fb || !groupId || unsubEvents) return;
    const { collection, onSnapshot } = fb.m;
    let pending = Promise.resolve();
    const listen = (name, apply) => onSnapshot(collection(fb.fs, 'groups', groupId, name), (snap) => {
      // 依序處理,避免同一筆資料的兩次變動交錯寫入
      pending = pending.then(async () => {
        let changed = false;
        for (const ch of snap.docChanges()) {
          if (ch.type === 'removed') continue;
          if (await apply(ch.doc)) changed = true;
        }
        if (changed && onRemoteChange) onRemoteChange();
      }).catch(e => console.warn('套用雲端變動失敗', e));
    }, (e) => console.warn(`監聽 ${name} 失敗`, e));
    unsubEvents = listen('events', (d) => this._applyEvent(d));
    unsubCalendars = listen('calendars', (d) => this._applyCalendar(d));
    unsubTodos = listen('todos', (d) => this._applyTodo(d));
    unsubTags = listen('personTags', (d) => this._applyTag(d));
    unsubMembers = onSnapshot(collection(fb.fs, 'groups', groupId, 'members'), async (snap) => {
      await this._applyMembers(snap.docChanges().filter(ch => ch.type !== 'removed').map(ch => ch.doc));
      if (onRemoteChange) onRemoteChange();
    }, () => {});
  },
};
