# 第三輪修改

實測跨手機邀請、即時對話、作廢重發、狀態恢復維持不變。這一輪只改下列項目。

1. `esc()` 改成用字元碼組 `&#` 數字，不再寫具名 HTML 實體，避免複製後語法被破壞、網站全白。
2. 術式第 4 項顯示名稱改為「其他自費門診手術（依醫師說明）」，`opCode` 仍是 `other`。
3. 醫師登入先 `signInWithPopup`，視窗被擋或失敗才 `signInWithRedirect`。使用者自己關掉視窗不改走 redirect。
4. 邀請碼欄接受完整連結。含 `#i/`、`#invite/` 或 `?i=` 時先取出 token。找不到時提示「找不到這組邀請碼，請掃 QR 或貼上醫師給的完整連結」。
5. 醫師把已有病人加入的案件設成一次性時，同時把 invite 設為 `used: true`。規則要求非開案者標 used 時必須 `oneTime == true`，且本人已是該案 member。
6. 寫入 members 成功後立刻 `history.replaceState` 成 `#case/<caseId>`，不等「我了解」。
7. 訊息 `onSnapshot` 加上錯誤 callback，被拒時顯示「沒有此案件權限，或網路中斷。」
8. 緊急視窗在查看與送出前可按 Esc 關閉，焦點回到原按鈕；「我了解」模式不能用 Esc 跳過。拿掉 `main` 的 `aria-live`，toast 維持 `role="status" aria-live="polite"`。

`node --check` 結果見當次回覆。
