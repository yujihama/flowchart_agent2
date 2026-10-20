/**
 * 決定論的な擬似乱数でさまざまなトポロジーのフローを生成し、
 * verify-edge-routing.ts と同じ仕様ルールで点検するストレステスト。
 * 実行: npx tsx scripts/stress-edge-routing.ts [ケース数]
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cases = Number(process.argv[2] ?? 20);

/** mulberry32: 再現可能な擬似乱数 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateFlow(seed: number) {
  const rand = rng(seed);
  const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)];
  const laneCount = 2 + Math.floor(rand() * 5);
  const lanes = Array.from({ length: laneCount }, (_, i) => ({
    id: `L${i + 1}`,
    name: `レーン${i + 1}`,
    type: "department",
  }));
  const phases = [{ id: "PH1", name: "フェーズ1" }];

  const nodeCount = 8 + Math.floor(rand() * 18);
  const nodes: Array<Record<string, unknown>> = [];
  nodes.push({ id: "N1", type: "start", label: "開始", lane_id: pick(lanes).id, phase_id: "PH1" });
  for (let i = 2; i < nodeCount; i += 1) {
    const type = rand() < 0.3 ? "decision" : rand() < 0.15 ? "system_process" : "process";
    nodes.push({ id: `N${i}`, type, label: `${type === "decision" ? "判断" : "処理"}${i}`, lane_id: pick(lanes).id, phase_id: "PH1" });
  }
  nodes.push({ id: `N${nodeCount}`, type: "end", label: "終了", lane_id: pick(lanes).id, phase_id: "PH1" });

  const edges: Array<Record<string, unknown>> = [];
  let edgeId = 0;
  const addEdge = (from: string, to: string, edgeType?: string) => {
    edgeId += 1;
    edges.push({ id: `E${edgeId}`, from, to, ...(edgeType ? { edge_type: edgeType } : {}), label: edgeType ? `分岐${edgeId}` : undefined });
  };
  // 前進の背骨: 各ノードから後方のどれかへ
  for (let i = 1; i < nodeCount; i += 1) {
    const from = `N${i}`;
    const to = `N${Math.min(nodeCount, i + 1 + Math.floor(rand() * 3))}`;
    if (from !== to) addEdge(from, to);
  }
  // decisionの追加分岐
  nodes.forEach((node, index) => {
    if (node.type !== "decision") return;
    const extra = 1 + Math.floor(rand() * 2);
    for (let k = 0; k < extra; k += 1) {
      const targetIndex = Math.min(nodeCount - 1, index + 1 + Math.floor(rand() * 4));
      if (targetIndex > index) addEdge(node.id as string, `N${targetIndex + 1}`);
    }
  });
  // 差戻し・例外
  const rollbackCount = 1 + Math.floor(rand() * 4);
  for (let k = 0; k < rollbackCount; k += 1) {
    const fromIndex = 2 + Math.floor(rand() * (nodeCount - 3));
    const toIndex = Math.max(1, fromIndex - 1 - Math.floor(rand() * (fromIndex - 1)));
    addEdge(`N${fromIndex + 1}`, `N${toIndex + 1}`, pick(["rollback", "exception", "escalation"]));
  }
  // 終了への合流を増やす
  const enders = 1 + Math.floor(rand() * 2);
  for (let k = 0; k < enders; k += 1) {
    const fromIndex = 2 + Math.floor(rand() * (nodeCount - 3));
    addEdge(`N${fromIndex}`, `N${nodeCount}`);
  }

  // 重複エッジ(同一from-to)は除去
  const seen = new Set<string>();
  const uniqueEdges = edges.filter((edge) => {
    const key = `${edge.from}->${edge.to}`;
    if (seen.has(key) || edge.from === edge.to) return false;
    seen.add(key);
    return true;
  });

  return {
    schema_version: "1.0",
    flow_id: `stress_${seed}`,
    title: `ストレステスト ${seed}`,
    lanes,
    phases,
    nodes,
    edges: uniqueEdges,
    sources: [],
  };
}

const dir = mkdtempSync(join(tmpdir(), "flow-stress-"));
let failed = 0;
for (let seed = 1; seed <= cases; seed += 1) {
  const flow = generateFlow(seed);
  const file = join(dir, `flow-${seed}.json`);
  writeFileSync(file, JSON.stringify(flow));
  const result = spawnSync("npx", ["tsx", resolve(here, "verify-edge-routing.ts"), file], {
    encoding: "utf-8",
  });
  const summary = (result.stdout ?? "").split("\n").slice(0, 2).join(" / ");
  if (result.status !== 0) {
    failed += 1;
    console.log(`seed=${seed}: NG  ${summary}`);
    console.log(
      (result.stdout ?? "")
        .split("\n")
        .filter((line) => line.includes("NG"))
        .slice(0, 12)
        .join("\n"),
    );
    console.log(`  再現: npx tsx scripts/verify-edge-routing.ts ${file}`);
  } else {
    console.log(`seed=${seed}: OK  ${summary}`);
  }
}
console.log(failed === 0 ? `全${cases}ケース通過` : `${failed}/${cases}ケースで違反`);
process.exit(failed === 0 ? 0 : 1);
