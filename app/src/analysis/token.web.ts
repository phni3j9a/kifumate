// Webは動作確認用。秘密鍵を取り出せないIndexedDBの鍵で暗号化し、平文トークンを保存しない。
// shortcut: 同一オリジンのスクリプトは復号できる。Webを製品化するときはサーバー側セッションへ移す。
const name = "kifumate-device-" + (process.env.EXPO_PUBLIC_ANALYSIS_URL || "");
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("device");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function read(db: IDBDatabase, key: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const r = db.transaction("device").objectStore("device").get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export const tokenStore = {
  async get() {
    const db = await database();
    try {
      const key = await read(db, "key"),
        data = await read(db, "token");
      return key && data
        ? new TextDecoder().decode(
            await crypto.subtle.decrypt(
              { name: "AES-GCM", iv: data.iv },
              key,
              data.value,
            ),
          )
        : null;
    } finally {
      db.close();
    }
  },
  async set(token: string) {
    const db = await database();
    try {
      const key = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const value = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(token),
      );
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("device", "readwrite");
        tx.objectStore("device").put(key, "key");
        tx.objectStore("device").put({ iv, value }, "token");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  },
};
