// バックアップのトランザクションへ、背景のDB更新が混ざらないようにする。
export let dataPaused = false;
const drains = new Map<() => Promise<unknown>, (() => void) | undefined>();
export function registerDataDrain(
  drain: () => Promise<unknown>,
  resume?: () => void,
) {
  drains.set(drain, resume);
  return () => {
    drains.delete(drain);
  };
}
export async function pauseData() {
  if (dataPaused) throw new Error("別のデータ操作が終わるまでお待ちください");
  dataPaused = true;
  try {
    await Promise.all([...drains.keys()].map((d) => d()));
  } catch (e) {
    resumeData();
    throw e;
  }
}
export function resumeData() {
  dataPaused = false;
  for (const resume of drains.values()) resume?.();
}
