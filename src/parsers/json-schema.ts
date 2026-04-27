import type { FlowModel } from "../domain/flow-model";
import { validateFlowModel } from "../domain/validators";

export type ParseResult =
  | {
      ok: true;
      model: FlowModel;
      validation: ReturnType<typeof validateFlowModel>;
    }
  | {
      ok: false;
      message: string;
    };

export function parseFlowModelJson(rawJson: string): ParseResult {
  try {
    const parsed = JSON.parse(rawJson) as FlowModel;
    const validation = validateFlowModel(parsed);
    return {
      ok: true,
      model: parsed,
      validation,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "JSONの解析に失敗しました",
    };
  }
}
