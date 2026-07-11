// パリティテスト用: アプリ本体の validators.ts で JSON ファイルを検証し、結果を出力する
import { readFileSync } from "node:fs";
import { validateFlowModel } from "../../src/domain/validators";

const raw = readFileSync(process.argv[2], "utf-8");
const result = validateFlowModel(JSON.parse(raw));
console.log(
  JSON.stringify({
    valid: result.valid,
    issues: result.issues.map((issue) => ({ level: issue.level, path: issue.path, message: issue.message })),
  }),
);
