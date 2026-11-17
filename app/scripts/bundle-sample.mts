// ローカルで作った解析結果を、表示用の固有名称を含まない同梱ファイルへまとめる。
import { readFileSync, writeFileSync } from "node:fs";
import { Record, RecordMetadataKey, SpecialMoveType, exportKIF } from "tsshogi";
const saved = JSON.parse(
  readFileSync(process.argv[2] || ".local/sample-analysis.json", "utf8"),
);
const record = Record.newByUSI(
  "position startpos moves " + saved.moves.join(" "),
);
if (record instanceof Error) throw record;
record.metadata.setStandardMetadata(RecordMetadataKey.BLACK_NAME, "tsubame");
record.metadata.setStandardMetadata(RecordMetadataKey.WHITE_NAME, "kawasemi");
record.metadata.setStandardMetadata(
  RecordMetadataKey.START_DATETIME,
  "2026/11/08",
);
record.append(SpecialMoveType.MATE);
const kif = exportKIF(record);
if (kif instanceof Error) throw kif;
writeFileSync(
  "src/assets/sample-game.json",
  JSON.stringify({ kif, saved }, null, 2) + "\n",
);
