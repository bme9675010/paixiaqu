// ===== 雲端同步設定(家人共享用)=====
// 尚未設定時,App 以「純本地模式」運作(資料只存在自己手機)。
// 想開啟家人共享,請照「SETUP-共享同步.md」的步驟申請免費 Firebase 專案,
// 然後把下面的值換成你自己的。
window.APP_CONFIG = {
  FIREBASE_API_KEY: '你的_FIREBASE_API_KEY',
  FIREBASE_AUTH_DOMAIN: '你的專案id.firebaseapp.com',
  FIREBASE_PROJECT_ID: '你的_FIREBASE_PROJECT_ID',
  FIREBASE_APP_ID: '你的_FIREBASE_APP_ID',
};
