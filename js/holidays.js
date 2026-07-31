import { db } from './db.js';

// 台灣國定假日,內建資料是離線/網路抓取失敗時的備援(僅固定假日與當年農曆節日,不含彈性補假/補班)
// App 啟動時會呼叫 refreshHolidays() 自動從網路更新,更新到的資料(含補假)會覆蓋/補進這個物件
export const HOLIDAYS = {
  '2026-01-01': '元旦',
  '2026-02-16': '除夕',
  '2026-02-17': '初一',
  '2026-02-18': '初二',
  '2026-02-19': '初三',
  '2026-02-28': '和平紀念日',
  '2026-04-04': '兒童節',
  '2026-04-05': '清明節',
  '2026-05-01': '勞動節',
  '2026-06-19': '端午節',
  '2026-09-25': '中秋節',
  '2026-09-28': '教師節',
  '2026-10-10': '國慶日',
  '2026-10-25': '光復節',
  '2026-12-25': '行憲紀念日',
  '2027-01-01': '元旦',
  '2027-02-05': '除夕',
  '2027-02-06': '初一',
  '2027-02-07': '初二',
  '2027-02-08': '初三',
  '2027-02-28': '和平紀念日',
  '2027-04-04': '兒童節',
  '2027-04-05': '清明節',
  '2027-05-01': '勞動節',
  '2027-06-09': '端午節',
  '2027-09-15': '中秋節',
  '2027-09-28': '教師節',
  '2027-10-10': '國慶日',
  '2027-10-25': '光復節',
  '2027-12-25': '行憲紀念日',
};

// 社群維護的台灣行事曆開放資料(內政部資料為基礎),每天一筆,含補假/補班資訊
const SOURCE = (year) => `https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/${year}.json`;
const REFRESH_INTERVAL = 7 * 24 * 3600 * 1000; // 快取一週,避免每次開 App 都重抓

function parseYearData(raw) {
  const map = {};
  for (const d of raw) {
    if (!d.description) continue;
    const ymd = `${d.date.slice(0, 4)}-${d.date.slice(4, 6)}-${d.date.slice(6, 8)}`;
    map[ymd] = d.description;
  }
  return map;
}

async function loadYear(year) {
  const cacheKey = `holidays_${year}`;
  const cached = await db.getMeta(cacheKey);
  if (cached && cached.data) Object.assign(HOLIDAYS, cached.data);
  if (cached && Date.now() - cached.fetchedAt < REFRESH_INTERVAL) return false;

  const resp = await fetch(SOURCE(year));
  if (!resp.ok) throw new Error(`${year} 年假日資料抓取失敗:${resp.status}`);
  const map = parseYearData(await resp.json());
  Object.assign(HOLIDAYS, map);
  await db.setMeta(cacheKey, { data: map, fetchedAt: Date.now() });
  return true;
}

// App 啟動時呼叫:自動更新今年+明年的國定假日資料,失敗就繼續用內建/快取資料
export async function refreshHolidays() {
  const y = new Date().getFullYear();
  let changed = false;
  for (const year of [y, y + 1]) {
    try {
      if (await loadYear(year)) changed = true;
    } catch (e) {
      console.warn(e.message || e);
    }
  }
  return changed;
}
