# 開啟「App 沒開也會通知」— 設定教學

這個功能需要一個小型排程服務(每 5 分鐘檢查一次有沒有行程要提醒),用 **Cloudflare Workers 免費方案**(不需信用卡)。我已經把程式都寫好放在 `worker/` 資料夾,只差兩把「鑰匙」需要你去申請——這兩步只有你自己能做(要用你的帳號登入),做完把內容貼給我,我幫你把剩下的部署完成。

## 第一把鑰匙:Firebase 服務帳戶金鑰

這是讓排程服務可以讀你的行事曆資料庫的權限。

1. 打開 [Firebase 主控台](https://console.firebase.google.com) → 你的 `scheduling` 專案
2. 左上角齒輪圖示 →「專案設定」
3. 上方分頁點「服務帳戶」(Service accounts)
4. 點「產生新的私密金鑰」(Generate new private key) → 確認下載
5. 會下載一個 `.json` 檔案 → 打開它,**把整個檔案內容貼給我**

⚠️ 這個檔案等同於你資料庫的完整存取密碼,請只貼給我(不要傳給別人、不要上傳到別的地方),我拿到後只會存成 Cloudflare 的加密環境變數,不會出現在程式碼或 GitHub 上。

## 第二把鑰匙:Cloudflare API Token

這是讓我可以幫你把排程服務部署上去的權限。

1. 免費註冊/登入 [dash.cloudflare.com](https://dash.cloudflare.com)(不需要信用卡)
2. 右上角帳號圖示 →「My Profile」→ 左邊「API Tokens」
3. 「Create Token」→ 找到「Edit Cloudflare Workers」範本 → 點「Use template」
4. 一路「Continue to summary」→「Create Token」
5. 複製顯示出來的 Token(只會顯示這一次)→ **貼給我**
6. 同一頁面或 Workers 總覽頁,也把左側欄位顯示的「**Account ID**」一併貼給我

⚠️ 這組 Token 只能操作 Workers,不能動你 Cloudflare 帳號的其他東西(範本已經限縮權限),但一樣請只貼給我,不要外流。

## 完成後

把這兩樣東西(Firebase 金鑰 JSON 全文 + Cloudflare Token/Account ID)貼給我,我會:
1. 把它們設成 Cloudflare Worker 的加密密鑰(不會出現在程式碼裡)
2. 部署排程服務
3. 帶你在 App 裡重新授權一次通知(舊的授權需要重新綁定推播訂閱)
4. 一起實測:新增一個 1-2 分鐘後要提醒的行程,把 App 切到背景或關掉,等通知跳出來

## 免費額度

Cloudflare Workers 免費方案:每天 10 萬次請求。這個排程每 5 分鐘跑一次 = 每天 288 次,完全用不到零頭。
