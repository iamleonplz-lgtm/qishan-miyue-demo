# 泌約｜旗山泌尿科　Firebase 設定

網站仍放在 GitHub Pages：https://iamleonplz-lgtm.github.io/qishan-miyue-demo/
Firebase 專案：`qishan-miyue`（Firestore 區域 asia-east1）。下面的 Web 設定已寫進 `firebase.js`，它是公開設定，安全靠 `firestore.rules`。

## 1. 確認 Firebase 專案

1. 打開 https://console.firebase.google.com/project/qishan-miyue
2. Firestore Database 必須是 **asia-east1（台灣）**。區域在建立資料庫時決定，客戶端不能改。
3. 若還沒建立資料庫：建立 → 正式版 → 區域選 asia-east1。

## 2. 開啟登入方式

Authentication → Sign-in method：

- 開啟 **Anonymous（匿名）**：病人用，不需要帳號。
- 開啟 **Google**：醫師用。
- Settings → Authorized domains 要有 `iamleonplz-lgtm.github.io`。本機測試再加 `localhost`。

## 3. 發布安全規則

1. Firestore → 規則。
2. 把本資料夾的 `firestore.rules` 全部貼上。
3. 按發布。沒發布之前，開案、加入、留言都會失敗。

規則重點：不能列出全部案件或邀請碼；醫師只能讀寫自己的案件；病人只能讀寫自己已加入的案件；邀請碼只能單筆讀取；訊息最長 500 字；化名最長 10 字，並擋身分證、手機、8 碼以上數字。

## 4. 把醫師加進白名單

App 不能自行註冊醫師。每位醫師：

1. 用自己的手機打開網站，按「醫師 Google 登入」。
2. 若看到「尚未加入醫師白名單」，複製畫面上的 uid。
3. Firestore → 開始建立集合 → 集合 ID：`doctors`。
4. 文件 ID 貼上 uid。欄位：
   - `name`（string）：曾淑芬、尤政仁、黃冠霖、張道安，依本人填，不要自行增減名單。
   - `active`（boolean）：`true`
5. 儲存後，醫師重新整理即可進入工作台。

目前程式只顯示這四位為院方名單，登入資格只看白名單，不看本機密碼。

## 5. 上傳 GitHub Pages

覆蓋這些檔案到 `qishan-miyue-demo` 儲存庫根目錄：

- `index.html`
- `app.js`
- `firebase.js`
- `style.css`
- `qrcode.js`
- `firestore.rules`（給版控；網站本身不會執行它）
- `README-setup.md`
- `測試清單.md`

不要上傳含病人資料的檔案。確認 GitHub Pages 來源是 main 分支根目錄。等一分鐘再重整。

## 6. 邀請碼怎麼運作

- 醫師開案後產生 12 碼邀請碼（排除 0/O/1/I），7 天有效。
- QR 在手機本機產生，不經過 api.qrserver.com。
- 連結只含 `#i/邀請碼`，不含姓名或病歷。
- 病人加入後，網址參數會清掉。
- 醫師可作廢並重發，也可設成一次性。一次性碼在登出後不能用新的匿名身分再加入。

## 7. 照片與緊急按鈕

- 照片只存在該支手機，不會上傳，醫師看不到。
- 「我有緊急狀況」不經過後端，沒有網路也能撥 119 或總機 07-6613811。

## 8. 這次沒代做的事

- 沒有替你按下 Firebase「發布規則」。
- 沒有把任何人的 uid 寫進 `doctors`。
- 沒有啟用 App Check。匿名登入仍可能被有邀請碼的人使用，這是示範版的取捨。
