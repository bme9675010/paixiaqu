# 開啟「家人共享」功能 — 設定教學

App 目前是**純本地模式**(資料只存在自己手機)。照下面步驟做一次(約 10 分鐘),就能開啟家人共享 + 即時同步 + 照片雲端備份。全部**免費**。

## 步驟 1:註冊 Supabase(免費)

1. 打開 https://supabase.com ,點「Start your project」
2. 用 Google 或 GitHub 帳號登入
3. 點「New Project」建立專案:
   - Name:隨便取,例如 `paixiaqu`
   - Database Password:設一個密碼(記下來,但之後其實用不太到)
   - Region:選 `Northeast Asia (Tokyo)` 離台灣最近
4. 等 1-2 分鐘專案建立完成

## 步驟 2:建立資料表

1. 左邊選單點「SQL Editor」
2. 打開專案資料夾裡的 `supabase/schema.sql`,全選複製
3. 貼到 SQL Editor,按「Run」
4. 看到 Success 就完成了

## 步驟 3:開啟匿名登入

1. 左邊選單點「Authentication」→「Sign In / Up」(或 Providers)
2. 找到「Anonymous Sign-Ins」,把它**開啟**並儲存

## 步驟 4:把金鑰填進 App

1. 左邊選單點「Project Settings」→「API Keys」
2. 複製兩個值:
   - **Project URL**(長得像 `https://xxxx.supabase.co`)
   - **anon public** key(一長串文字)
3. 打開專案裡的 `config.js`,換成你的值:

```js
window.APP_CONFIG = {
  SUPABASE_URL: 'https://xxxx.supabase.co',
  SUPABASE_ANON_KEY: '你複製的anon key',
};
```

4. 重新部署(跟平常更新 App 一樣 git push 即可)

## 步驟 5:建立家庭群組

1. 打開 App →「⚙️ 設定」→「家人共享」
2. 填暱稱(例如:爸爸)→ 按「建立家庭群組」
3. 會得到一組 **6 位邀請碼**
4. 家人在自己手機打開同一個 App 網址 → 設定 → 輸入邀請碼 → 加入
5. 完成!之後任何人新增/修改行程,大家的手機都會即時同步 🎉

---

## 之後想加「雲端推播提醒」(進階,可以之後再做)

目前的提醒通知在 **App 開著的時候**會跳出。iPhone 要做到「App 沒開也會跳通知」,需要:

1. iOS 16.4 以上,而且 App 要**從主畫面圖示開啟**(已加入主畫面)
2. 加一個推播伺服器(可用 Supabase Edge Functions + pg_cron 排程,每分鐘檢查要提醒的行程並發 Web Push)

這部分比較複雜,等共享功能跑順之後,跟 Claude 說「幫我加雲端推播提醒」再一起做。

## 免費額度夠用嗎?

Supabase 免費方案:資料庫 500MB、儲存空間 1GB、每月 5 萬次匿名登入。
一家人共用行事曆的用量遠低於這個額度,照片有自動壓縮(長邊 1280px,每張約 100-300KB),1GB 大約可存 5000 張,夠用很久。
