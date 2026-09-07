# RO 露天商店低頻查價工具

這是一個人工驗證優先的 Playwright 工具：使用可見瀏覽器正常操作公開查詢頁，加入 SQLite 快取、去重、每日上限與 30–50 分鐘隨機間隔。它不會解答或繞過 CAPTCHA/Turnstile。

## 首次設定

```powershell
.\.venv\Scripts\Activate.ps1
Copy-Item config.example.json config.json
```

編輯 `config.json` 內的 `items`，每個項目包含道具名稱與 `max_price` 通知門檻。在專案根目錄建立 `.env`：

```dotenv
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

`.env` 已被 `.gitignore` 排除。首次執行可能需要在開啟的瀏覽器中手動登入或完成驗證。瀏覽器狀態儲存於 `data/browser-profile`。

## 先試跑一次

```powershell
.\.venv\Scripts\python.exe main.py --once
```

## 啟動低頻輪詢

```powershell
.\.venv\Scripts\python.exe main.py
```

結果儲存於 `data/prices.db`。遇到驗證逾時、限制頁或非預期錯誤時，程式會停止，不會密集重試。

當最低販售價低於或等於 `max_price` 時，程式會發送 Discord 通知。同一道具預設有 30 分鐘冷卻；冷卻期內若出現更低價，仍會立即通知。
