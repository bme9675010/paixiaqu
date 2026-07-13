# 開啟「家人共享」功能 — 設定教學

App 目前是**純本地模式**(資料只存在自己手機)。照下面步驟做一次(約 10 分鐘),就能開啟家人共享 + 即時同步 + 照片雲端備份。使用 **Google Firebase 免費方案(Spark)**,完全免費、不需要信用卡。

> 之前用的是 Supabase,但免費帳號限制「最多 2 個活躍專案」,若你的帳號已被其他專案占滿,改用 Firebase 就沒有這個問題(Firebase 免費額度是用量計算,不是專案數量)。

## 步驟 1:建立 Firebase 專案

1. 打開 https://console.firebase.google.com ,用 Google 帳號登入
2. 點「新增專案」(Add project)
3. 輸入專案名稱,例如 `paixiaqu`
4. 「這個專案要使用 Google Analytics 嗎?」→ 可以關閉(不需要),按繼續
5. 等待建立完成

## 步驟 2:註冊網頁 App,取得金鑰

1. 專案總覽頁面,點「</>」(網頁)圖示新增網頁應用程式
2. 應用程式暱稱隨便取,不用勾「同時設定 Firebase Hosting」
3. 點「註冊應用程式」後,會看到一段 `firebaseConfig = {...}` 程式碼,裡面有：
   - `apiKey`
   - `authDomain`
   - `projectId`
   - `appId`
4. 打開專案裡的 `config.js`,把這四個值填進去：

```js
window.APP_CONFIG = {
  FIREBASE_API_KEY: 'AIzaSy...',
  FIREBASE_AUTH_DOMAIN: 'paixiaqu-xxxx.firebaseapp.com',
  FIREBASE_PROJECT_ID: 'paixiaqu-xxxx',
  FIREBASE_APP_ID: '1:xxxx:web:xxxx',
};
```

## 步驟 3:開啟匿名登入

1. 左邊選單「建構」(Build) →「Authentication」→「開始使用」
2. 「Sign-in method」分頁 → 找到「匿名」(Anonymous) → 點進去 → 啟用 → 儲存

## 步驟 4:建立資料庫

1. 左邊選單「建構」→「Firestore Database」→「建立資料庫」
2. 位置選 `asia-east1`(台灣)或 `asia-northeast1`(東京)
3. 安全性規則選「**正式版模式**」(production mode,不要選測試模式)
4. 建立完成後,點上方「規則」(Rules)分頁
5. 打開專案裡的 `firebase/firestore.rules`,全選複製,貼到主控台的規則編輯框(蓋掉原本內容)
6. 點「發布」(Publish)

## 步驟 5:重新部署

改完 `config.js` 後,跟平常更新 App 一樣 git push(或跟我說「幫我部署」)即可生效。

## 步驟 6:建立家庭群組

1. 打開 App →「⚙️ 設定」→「家人共享」
2. 填暱稱(例如:爸爸)→ 按「建立家庭群組」
3. 會得到一組 **6 位邀請碼**
4. 家人在自己手機打開同一個 App 網址 → 設定 → 輸入邀請碼 → 加入
5. 完成!之後任何人新增/修改行程,大家的手機都會即時同步 🎉

---

## 之後想加「雲端推播提醒」(進階,可以之後再做)

目前的提醒通知在 **App 開著的時候**會跳出。iPhone 要做到「App 沒開也會跳通知」,需要:

1. iOS 16.4 以上,而且 App 要**從主畫面圖示開啟**(已加入主畫面)
2. 加一個推播伺服器(可用 Firebase Cloud Functions 排程檢查要提醒的行程並發送 Web Push)

這部分比較複雜,等共享功能跑順之後,跟 Claude 說「幫我加雲端推播提醒」再一起做。

## 免費額度夠用嗎?

Firebase 免費方案(Spark)：Firestore 每天 5 萬次讀取、2 萬次寫入、1GB 儲存空間,完全不需要信用卡。
一家人共用行事曆的用量遠低於這個額度。照片直接以壓縮過的 base64 存進 Firestore(每張約 100-300KB,長邊自動縮到 1280px),1GB 大約可存 3000-5000 張,夠用很久。若哪天真的超過免費額度,Firebase 會停用超額功能,**不會自動收費**(除非你手動升級到付費方案)。
