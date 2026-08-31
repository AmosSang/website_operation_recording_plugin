// Journey Recorder - IndexedDB 单一写入口（决策 D6：仅 service worker 写，DevTools 可直接查）
// DB: journey-recorder  六 store：journeys / steps / netCalls / rrEvents / audio / pageAssets
const JR_DB_NAME = 'journey-recorder';
const JR_DB_VERSION = 2; // v2：S8 新增 pageAssets（每页一套资源），结构兼容旧库
let _dbPromise = null;

function openJRDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(JR_DB_NAME, JR_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('journeys')) {
        db.createObjectStore('journeys', { keyPath: 'journeyId' });
      }
      if (!db.objectStoreNames.contains('steps')) {
        db.createObjectStore('steps', { keyPath: 'key' }); // S6 定稿 key 结构
      }
      if (!db.objectStoreNames.contains('netCalls')) {
        const s = db.createObjectStore('netCalls', { keyPath: 'id', autoIncrement: true });
        s.createIndex('by_journey', 'journeyId');
      }
      if (!db.objectStoreNames.contains('rrEvents')) {
        const s = db.createObjectStore('rrEvents', { keyPath: 'id', autoIncrement: true });
        s.createIndex('by_journey', 'journeyId');
      }
      if (!db.objectStoreNames.contains('audio')) {
        const s = db.createObjectStore('audio', { keyPath: 'id', autoIncrement: true });
        s.createIndex('by_journey', 'journeyId');
      }
      if (!db.objectStoreNames.contains('pageAssets')) {
        // S8 资源抓取：每页一套（CSS/字体/图片），keyPath=pageUrl（pageKey 去重）
        const s = db.createObjectStore('pageAssets', { keyPath: 'pageUrl' });
        s.createIndex('by_journey', 'journeyId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

async function jrAdd(storeName, value) {
  const db = await openJRDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).add(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function jrPut(storeName, value) {
  const db = await openJRDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function jrGet(storeName, key) {
  const db = await openJRDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
