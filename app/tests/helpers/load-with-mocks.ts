import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Expoのネイティブ境界だけを差し替え、実際の画面・リポジトリのコードを実行する。
export function loadWithMocks<T>(
  filename: string,
  mocks: Record<string, unknown>,
): T {
  const path = resolve(filename),
    exports = {};
  const nativeRequire = createRequire(path);
  const { outputText } = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  });
  runInNewContext(
    outputText,
    {
      exports,
      Error,
      require: (id: string) => (id in mocks ? mocks[id] : nativeRequire(id)),
    },
    { filename: path },
  );
  return exports as T;
}
