// バックアップのトランザクションへ、背景のDB更新が混ざらないようにする。
export let dataPaused = false;
const drains = new Set<() => Promise<unknown>>();
export function registerDataDrain(drain: () => Promise<unknown>) {
  drains.add(drain);
  return () => {
    drains.delete(drain);
  };
}
export async function pauseData() {
  if (dataPaused) throw new Error("別のデータ操作が終わるまでお待ちください");
  dataPaused = true;
  try {
    await Promise.all([...drains].map((d) => d()));
  } catch (e) {
    dataPaused = false;
    throw e;
  }
}
export function resumeData() {
  dataPaused = false;
}
