// 雲端同步 (Firebase Firestore) — 家人共享行事曆
// 未設定 config.js 的 Firebase 金鑰時,App 以純本地模式運作。
import { db } from './db.js';

const SDK_VER = '10.12.2';
const PHOTO_MAX_BASE64 = 900000; // Firestore 單一文件上限 1MiB,照片留安全邊界

let fb = null; // { auth, fs, uid, mods:{...firestore funcs} }
let groupId = null;
let onRemoteChange = null;
let toast = () => {};
let unsubEvents = null, unsubCalendars = null;

const $ = id => document.getElementById(id);

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
      groupId = await db.getMeta('groupId');
      if (groupId) {
        await this.pullAll();
        this.subscribe();
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
        $('groupInfo').innerHTML = groupId
          ? `✅ 已加入家庭群組<br>邀請碼:<b style="font-size:18px;letter-spacing:2px">${code || ''}</b><br>把邀請碼給家人,他們在自己手機的 App 輸入即可共享。`
          : '尚未加入群組。建立一個新群組,或輸入家人給你的邀請碼。';
      });
    });
    $('btnCreateGroup').onclick = () => this.createGroup();
    $('btnJoinGroup').onclick = () => this.joinGroup($('joinCode').value.trim());
    $('syncName').onchange = () => db.setMeta('memberName', $('syncName').value.trim());
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
    } else {
      // 建立新群組:本機既有資料就是這個群組的初始資料
      const cals = await db.getAll('calendars');
      const evs = await db.getAll('events');
      for (const c of cals) await this.pushCalendar(c);
      for (const e of evs) await this.pushEvent(e);
    }

    await this.pullAll();
    this.subscribe();
    this.renderStatus();
    if (onRemoteChange) onRemoteChange();
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

  async pushEvent(ev) {
    if (!fb || !groupId) return;
    try {
      const { doc, setDoc } = fb.m;
      // 照片直接存進 Firestore(base64),避免需要開通付費的 Storage
      for (const pid of (ev.photos || [])) {
        const p = await db.get('photos', pid);
        if (!p || p.synced) continue;
        if (p.data.length > PHOTO_MAX_BASE64) { console.warn('照片太大,略過雲端同步:', pid); continue; }
        await setDoc(doc(fb.fs, 'groups', groupId, 'photos', pid), { data: p.data, updatedAtMs: p.updatedAt || Date.now() });
        p.synced = true;
        await db.put('photos', p);
      }
      await setDoc(doc(fb.fs, 'groups', groupId, 'events', ev.id), {
        calendarId: ev.calendarId, title: ev.title, allDay: ev.allDay,
        startAt: ev.start, endAt: ev.end,
        repeat: ev.repeat || 'none', exdates: ev.exdates || [],
        reminder: ev.reminder, notes: ev.notes || '',
        photoIds: ev.photos || [],
        deleted: !!ev.deleted, updatedAtMs: ev.updatedAt,
      });
    } catch (e) { console.warn('push event 失敗', e); }
  },

  // 從雲端拉全部資料,以 updatedAt 較新者為準
  async pullAll() {
    if (!fb || !groupId) return;
    try {
      const { doc, getDoc, collection, getDocs } = fb.m;
      const calSnap = await getDocs(collection(fb.fs, 'groups', groupId, 'calendars'));
      for (const d of calSnap.docs) {
        const rc = d.data();
        const local = await db.get('calendars', d.id);
        if (!local || rc.updatedAtMs > local.updatedAt) {
          await db.put('calendars', {
            id: d.id, name: rc.name, color: rc.color,
            hidden: local ? local.hidden : false,
            deleted: rc.deleted, updatedAt: rc.updatedAtMs,
          });
        }
      }
      const evSnap = await getDocs(collection(fb.fs, 'groups', groupId, 'events'));
      for (const d of evSnap.docs) {
        const re = d.data();
        const local = await db.get('events', d.id);
        if (!local || re.updatedAtMs > local.updatedAt) {
          const photoIds = re.photoIds || [];
          for (const pid of photoIds) {
            const existing = await db.get('photos', pid);
            if (existing) continue;
            try {
              const pSnap = await getDoc(doc(fb.fs, 'groups', groupId, 'photos', pid));
              if (pSnap.exists()) {
                await db.put('photos', { id: pid, data: pSnap.data().data, synced: true, updatedAt: Date.now() });
              }
            } catch { /* 照片抓不到就略過 */ }
          }
          await db.put('events', {
            id: d.id, calendarId: re.calendarId, title: re.title,
            allDay: re.allDay, start: re.startAt, end: re.endAt,
            repeat: re.repeat, exdates: re.exdates || [], reminder: re.reminder, notes: re.notes,
            photos: photoIds, deleted: re.deleted, updatedAt: re.updatedAtMs,
          });
        }
      }
    } catch (e) { console.warn('pull 失敗', e); }
  },

  // 即時訂閱:家人改了行程,自己手機馬上更新
  subscribe() {
    if (!fb || !groupId || unsubEvents) return;
    const { collection, onSnapshot } = fb.m;
    let first1 = true, first2 = true;
    unsubEvents = onSnapshot(collection(fb.fs, 'groups', groupId, 'events'), async () => {
      if (first1) { first1 = false; return; } // 略過初次訂閱時的既有快照(pullAll 已處理過)
      await this.pullAll();
      if (onRemoteChange) onRemoteChange();
    });
    unsubCalendars = onSnapshot(collection(fb.fs, 'groups', groupId, 'calendars'), async () => {
      if (first2) { first2 = false; return; }
      await this.pullAll();
      if (onRemoteChange) onRemoteChange();
    });
  },
};
