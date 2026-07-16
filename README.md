# 給他排下去 📅

家庭共享行事曆 PWA — 自製的 TimeTree 完整版,免費、無廣告、所有進階功能全開。

## 功能

- 📅 **月檢視**:整月一覽,行程色塊顯示,點日期看當天清單
- 📊 **垂直週檢視**:TimeTree 付費版才有的縱向時間軸,一眼看清整週
- 🕐 **日檢視**:單日時間軸,含目前時間紅線
- 🗂️ **多本行事曆**:家庭/工作/個人分開管理,10 色可選,可隱藏
- 📷 **照片附件**:行程可附多張照片(自動壓縮)
- 🔁 **重複行程**:每天/每週/每月/每年
- 🔔 **提醒通知**:準時~1天前提醒,設定雲端推播後 App 沒開也會收到(見 SETUP-推播提醒.md)
- 👨‍👩‍👧‍👦 **家人共享**:邀請碼加入家庭群組,行程即時同步(需照 SETUP 設定)
- 💾 **備份**:JSON 匯出/匯入
- 🌙 深色模式自動跟隨系統
- 📴 離線可用(PWA)

## 安裝到 iPhone

1. 用 Safari 打開部署後的網址
2. 點分享按鈕 →「加入主畫面」
3. 從主畫面開啟,就是全螢幕 App

## 專案結構

```
index.html            主頁面
css/style.css         樣式
js/app.js             主程式(檢視渲染、行程 CRUD、提醒)
js/db.js              本地資料庫(IndexedDB)
js/sync.js            雲端同步(Firebase Firestore,家人共享)
config.js             同步設定(填入 Firebase 金鑰後開啟共享)
sw.js                 Service Worker(離線快取、通知)
manifest.webmanifest  PWA 設定
icons/                App 圖示
firebase/firestore.rules  雲端資料庫安全規則
worker/               Cloudflare Worker(每 5 分鐘檢查提醒、發送雲端推播)
SETUP-共享同步.md      家人共享設定教學
SETUP-推播提醒.md      雲端推播設定教學
```

## 開啟家人共享

見 [SETUP-共享同步.md](SETUP-共享同步.md)(免費 Firebase 專案,約 10 分鐘,不需信用卡)。

## 資料儲存

- 本地:IndexedDB(手機裡),不設定雲端也能完整使用
- 雲端(選用):Firebase 免費方案(Spark),家庭群組共享 + 即時同步 + 照片備份
