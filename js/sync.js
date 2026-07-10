// 雲端同步 (Supabase) — 家人共享行事曆
// 未設定 config.js 的 SUPABASE_URL 時,App 以純本地模式運作。
import { db } from './db.js';

let supa = null;
let groupId = null;
let onRemoteChange = null;
let toast = () => {};
let channel = null;

const $ = id => document.getElementById(id);

function configured() {
  return typeof window.APP_CONFIG === 'object'
    && window.APP_CONFIG.SUPABASE_URL
    && !window.APP_CONFIG.SUPABASE_URL.includes('你的');
}

async function loadSupabase() {
  const mod = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  return mod.createClient(window.APP_CONFIG.SUPABASE_URL, window.APP_CONFIG.SUPABASE_ANON_KEY);
}

export const sync = {
  async init(opts) {
    onRemoteChange = opts.onRemoteChange;
    toast = opts.toast;
    if (!configured()) return;
    try {
      supa = await loadSupabase();
      // 匿名登入(每台裝置一個身分)
      const { data: { session } } = await supa.auth.getSession();
      if (!session) await supa.auth.signInAnonymously();
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
    if (!supa) return;
    try {
      const code = Math.random().toString(36).slice(2, 8).toUpperCase();
      const { data, error } = await supa.from('groups').insert({ invite_code: code, name: '我的家庭' }).select().single();
      if (error) throw error;
      await this._joined(data.id, code);
      toast('群組建立成功 🎉');
    } catch (e) { toast('建立失敗:' + e.message); }
  },

  async joinGroup(code) {
    if (!supa || !code) { toast('請輸入邀請碼'); return; }
    try {
      const { data, error } = await supa.from('groups').select().eq('invite_code', code.toUpperCase()).single();
      if (error || !data) throw new Error('找不到這個邀請碼');
      await this._joined(data.id, data.invite_code);
      toast('加入成功 🎉');
    } catch (e) { toast('加入失敗:' + e.message); }
  },

  async _joined(gid, code) {
    groupId = gid;
    await db.setMeta('groupId', gid);
    await db.setMeta('groupCode', code);
    const { data: { user } } = await supa.auth.getUser();
    await supa.from('members').upsert({ group_id: gid, user_id: user.id, name: (await db.getMeta('memberName')) || '家人' });
    // 把本地既有資料推上雲端
    const cals = await db.getAll('calendars');
    const evs = await db.getAll('events');
    for (const c of cals) await this.pushCalendar(c);
    for (const e of evs) await this.pushEvent(e);
    await this.pullAll();
    this.subscribe();
    this.renderStatus();
    if (onRemoteChange) onRemoteChange();
  },

  async pushCalendar(cal) {
    if (!supa || !groupId) return;
    try {
      await supa.from('calendars').upsert({
        id: cal.id, group_id: groupId, name: cal.name, color: cal.color,
        deleted: !!cal.deleted, updated_at_ms: cal.updatedAt,
      });
    } catch (e) { console.warn('push calendar 失敗', e); }
  },

  async pushEvent(ev) {
    if (!supa || !groupId) return;
    try {
      // 照片上傳到 Storage
      const photoUrls = [];
      for (const pid of (ev.photos || [])) {
        const p = await db.get('photos', pid);
        if (!p) continue;
        if (p.url) { photoUrls.push(p.url); continue; }
        const blob = await (await fetch(p.data)).blob();
        const path = `${groupId}/${pid}.jpg`;
        const { error } = await supa.storage.from('photos').upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
        if (!error) {
          const { data } = supa.storage.from('photos').getPublicUrl(path);
          p.url = data.publicUrl;
          await db.put('photos', p);
          photoUrls.push(p.url);
        }
      }
      await supa.from('events').upsert({
        id: ev.id, group_id: groupId, calendar_id: ev.calendarId,
        title: ev.title, all_day: ev.allDay, start_at: ev.start, end_at: ev.end,
        repeat: ev.repeat || 'none', exdates: ev.exdates || [], reminder: ev.reminder, notes: ev.notes || '',
        photo_urls: photoUrls, photo_ids: ev.photos || [],
        deleted: !!ev.deleted, updated_at_ms: ev.updatedAt,
      });
    } catch (e) { console.warn('push event 失敗', e); }
  },

  // 從雲端拉全部資料,以 updatedAt 較新者為準
  async pullAll() {
    if (!supa || !groupId) return;
    try {
      const { data: cals } = await supa.from('calendars').select().eq('group_id', groupId);
      for (const rc of (cals || [])) {
        const local = await db.get('calendars', rc.id);
        if (!local || rc.updated_at_ms > local.updatedAt) {
          await db.put('calendars', {
            id: rc.id, name: rc.name, color: rc.color,
            hidden: local ? local.hidden : false,
            deleted: rc.deleted, updatedAt: rc.updated_at_ms,
          });
        }
      }
      const { data: evs } = await supa.from('events').select().eq('group_id', groupId);
      for (const re of (evs || [])) {
        const local = await db.get('events', re.id);
        if (!local || re.updated_at_ms > local.updatedAt) {
          // 下載照片
          const photoIds = re.photo_ids || [];
          for (let i = 0; i < photoIds.length; i++) {
            const existing = await db.get('photos', photoIds[i]);
            if (!existing && re.photo_urls && re.photo_urls[i]) {
              try {
                const resp = await fetch(re.photo_urls[i]);
                const blob = await resp.blob();
                const dataUrl = await new Promise(res => {
                  const r = new FileReader();
                  r.onload = () => res(r.result);
                  r.readAsDataURL(blob);
                });
                await db.put('photos', { id: photoIds[i], data: dataUrl, url: re.photo_urls[i], updatedAt: Date.now() });
              } catch { /* 照片抓不到就略過 */ }
            }
          }
          await db.put('events', {
            id: re.id, calendarId: re.calendar_id, title: re.title,
            allDay: re.all_day, start: re.start_at, end: re.end_at,
            repeat: re.repeat, exdates: re.exdates || [], reminder: re.reminder, notes: re.notes,
            photos: photoIds, deleted: re.deleted, updatedAt: re.updated_at_ms,
          });
        }
      }
    } catch (e) { console.warn('pull 失敗', e); }
  },

  // 即時訂閱:家人改了行程,自己手機馬上更新
  subscribe() {
    if (!supa || !groupId || channel) return;
    channel = supa.channel('group-' + groupId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'events', filter: `group_id=eq.${groupId}` },
        async () => { await this.pullAll(); if (onRemoteChange) onRemoteChange(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'calendars', filter: `group_id=eq.${groupId}` },
        async () => { await this.pullAll(); if (onRemoteChange) onRemoteChange(); })
      .subscribe();
  },
};
