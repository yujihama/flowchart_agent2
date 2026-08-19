import type { Node } from "@xyflow/react";
import type { EdgeAnchorInfo, FlowNodeData, LaneNodeData } from "../layout/flow-reactflow-types";
import {
  ANCHOR_PERCENTS,
  LANE_HEADER_HEIGHT,
  LANE_PALETTE,
  LANE_WIDTH,
  NODE_HEIGHT_BY_TYPE,
  NODE_WIDTH_BY_TYPE,
  SIDE_ANCHOR_OFFSETS,
} from "../layout/swimlane-constants";
import type { FlowExportContext } from "./flow-exporters";
import { zipStore } from "./zip-store";

/**
 * OpenDocument Graphics (.odg) エクスポート。LibreOffice Draw向け。
 *
 * ノードはグループ図形、エッジはDraw純正コネクタ(draw:connector)として出力し、
 * 本体矩形に画面と同じ並びのグルーポイントを定義して両端を接着する。
 * LibreOffice Draw上でノードを動かすとエッジが追従して再ルーティングされる
 * (初期表示はレイアウトエンジン確定の経路をsvg:dで与える。移動後の経路は
 * Drawのルーティングエンジンによる)。
 */

const FONT_JA = "Yu Gothic UI";
const PX_PER_INCH = 96;
/** ODFのviewBox/パス座標は1/100mm単位 */
const MM100_PER_PX = (25.4 / PX_PER_INCH) * 100;

type Point = { x: number; y: number };
type DiagramBounds = { x: number; y: number; width: number; height: number };

export function createOdgBlob(context: FlowExportContext) {
  return new Blob([zipStore(buildOdgFiles(context))], {
    type: "application/vnd.oasis.opendocument.graphics",
  });
}

function buildOdgFiles(context: FlowExportContext) {
  const bounds = getDiagramBounds(context.nodes, context.edges);
  const styles = createStyleRegistry();
  const pageXml = buildPageXml(context, bounds, styles);

  const files = new Map<string, string | Uint8Array>();
  // mimetypeはZIPの先頭エントリでなければならない(zipStoreは挿入順を保持する)
  files.set("mimetype", "application/vnd.oasis.opendocument.graphics");
  files.set("META-INF/manifest.xml", manifestXml());
  files.set("meta.xml", metaXml());
  files.set("styles.xml", stylesXml(bounds));
  files.set("content.xml", contentXml(pageXml, styles.render()));
  return files;
}

function manifestXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">',
    '<manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="application/vnd.oasis.opendocument.graphics"/>',
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>',
    '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>',
    '<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>',
    "</manifest:manifest>",
  ].join("");
}

function metaXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.2">',
    "<office:meta><meta:generator>Flowchart Export</meta:generator></office:meta>",
    "</office:document-meta>",
  ].join("");
}

function fontFaceDeclsXml() {
  return `<office:font-face-decls><style:font-face style:name="${FONT_JA}" svg:font-family="'${FONT_JA}'" style:font-family-generic="swiss" style:font-pitch="variable"/></office:font-face-decls>`;
}

function stylesXml(bounds: DiagramBounds) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" office:version="1.2">',
    fontFaceDeclsXml(),
    "<office:styles>",
    // 矢印(LibreOffice標準のArrowと同形状)と破線の定義
    '<draw:marker draw:name="Arrow" svg:viewBox="0 0 20 30" svg:d="m10 0-10 30h20z"/>',
    '<draw:stroke-dash draw:name="Dash" draw:style="rect" draw:dots1="1" draw:dots1-length="0.073in" draw:distance="0.052in"/>',
    "</office:styles>",
    "<office:automatic-styles>",
    `<style:page-layout style:name="PM0"><style:page-layout-properties fo:page-width="${inch(bounds.width)}" fo:page-height="${inch(bounds.height)}" fo:margin-top="0in" fo:margin-bottom="0in" fo:margin-left="0in" fo:margin-right="0in" style:print-orientation="landscape"/></style:page-layout>`,
    '<style:style style:name="Mdp1" style:family="drawing-page"><style:drawing-page-properties draw:background-size="border" draw:fill="solid" draw:fill-color="#eef2f5"/></style:style>',
    "</office:automatic-styles>",
    "<office:master-styles>",
    '<style:master-page style:name="Default" style:page-layout-name="PM0" draw:style-name="Mdp1"/>',
    "</office:master-styles>",
    "</office:document-styles>",
  ].join("");
}

function contentXml(pageXml: string, autoStylesXml: string) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" office:version="1.2">',
    fontFaceDeclsXml(),
    `<office:automatic-styles>${autoStylesXml}</office:automatic-styles>`,
    "<office:body><office:drawing>",
    `<draw:page draw:name="page1" draw:master-page-name="Default">${pageXml}</draw:page>`,
    "</office:drawing></office:body>",
    "</office:document-content>",
  ].join("");
}

/** 同一定義を使い回す自動スタイルレジストリ */
type StyleRegistry = {
  graphic: (propsXml: string) => string;
  paragraph: (propsXml: string) => string;
  render: () => string;
};

function createStyleRegistry(): StyleRegistry {
  const entries: string[] = [];
  const byKey = new Map<string, string>();
  const intern = (family: "graphic" | "paragraph", prefix: string, propsXml: string) => {
    const key = `${family}|${propsXml}`;
    const found = byKey.get(key);
    if (found) return found;
    const name = `${prefix}${byKey.size + 1}`;
    byKey.set(key, name);
    const inner =
      family === "graphic"
        ? `<style:graphic-properties ${propsXml}/>`
        : propsXml;
    entries.push(`<style:style style:name="${name}" style:family="${family}">${inner}</style:style>`);
    return name;
  };
  return {
    graphic: (propsXml) => intern("graphic", "gr", propsXml),
    paragraph: (propsXml) => intern("paragraph", "P", propsXml),
    render: () => entries.join(""),
  };
}

function getDiagramBounds(nodes: FlowExportContext["nodes"], edges: FlowExportContext["edges"]): DiagramBounds {
  const points: Point[] = [];
  nodes.forEach((node) => {
    const width = node.data.kind === "lane" ? (node.data.width ?? LANE_WIDTH) : NODE_WIDTH_BY_TYPE[node.data.node.type];
    const height = node.data.kind === "lane" ? node.data.height : NODE_HEIGHT_BY_TYPE[node.data.node.type];
    points.push({ x: node.position.x, y: node.position.y }, { x: node.position.x + width, y: node.position.y + height });
  });
  edges.forEach((edge) => points.push(...(edge.data?.routePath ?? [])));
  const minX = Math.min(...points.map((point) => point.x), 0);
  const minY = Math.min(...points.map((point) => point.y), 0);
  const maxX = Math.max(...points.map((point) => point.x), 900);
  const maxY = Math.max(...points.map((point) => point.y), 600);
  const padding = 36;
  return {
    x: Math.floor(minX - padding),
    y: Math.floor(minY - padding),
    width: Math.ceil(maxX - minX + padding * 2),
    height: Math.ceil(maxY - minY + padding * 2),
  };
}

function buildPageXml({ model, nodes, edges }: FlowExportContext, bounds: DiagramBounds, styles: StyleRegistry) {
  let idCounter = 0;
  const nextId = () => {
    idCounter += 1;
    return `id${idCounter}`;
  };
  const laneNodes = nodes.filter((node): node is Node<LaneNodeData> => node.data.kind === "lane");
  const flowNodes = nodes.filter((node): node is Node<FlowNodeData> => node.data.kind === "flow");

  // ノードを先に構築し、コネクタの接着先(draw:id)を確定させる
  const anchorIdByNodeId = new Map<string, string>();
  const nodeXml: string[] = [];
  flowNodes.forEach((node) => {
    const built = buildNodeShapes(node, bounds, styles, nextId);
    anchorIdByNodeId.set(node.id, built.anchorId);
    nodeXml.push(built.xml);
  });

  const laneXml = laneNodes.map((lane) => buildLaneShapes(lane, bounds, styles));
  const edgeXml = edges
    .map((edge) => buildConnector(edge, bounds, styles, anchorIdByNodeId))
    .filter((shape): shape is string => shape !== null);
  const labelXml = edges
    .map((edge) => buildEdgeLabel(edge, bounds, styles))
    .filter((shape): shape is string => shape !== null);
  const footer = textFrame(bounds, styles, {
    x: bounds.x + 20,
    y: bounds.y + bounds.height - 26,
    width: 300,
    height: 16,
    lines: [{ text: model.flow_id, fontPx: 11, color: "#657784", bold: false }],
    align: "left",
  });

  // コネクタはノードより後に描く: 矢印はノード境界のグルーポイント位置に
  // 描画されるため、ノードを上に重ねると塗りで隠れてしまう
  return [...laneXml, ...nodeXml, ...edgeXml, ...labelXml, footer].join("");
}

/** レーン一式(背景・ヘッダー・アクセント・タイトル)を1グループに */
function buildLaneShapes(lane: Node<LaneNodeData>, bounds: DiagramBounds, styles: StyleRegistry) {
  const { lane: laneInfo, laneIndex, height, width = LANE_WIDTH } = lane.data;
  const color = LANE_PALETTE[laneIndex % LANE_PALETTE.length];
  const x = lane.position.x;
  const y = lane.position.y;

  return [
    "<draw:g>",
    rect(bounds, styles, { x, y, width, height, fill: color.fill, lineColor: "#c8d4dc" }),
    rect(bounds, styles, { x, y, width, height: LANE_HEADER_HEIGHT, fill: color.header, lineColor: "#c8d4dc" }),
    rect(bounds, styles, { x, y, width: 5, height: LANE_HEADER_HEIGHT, fill: color.accent, lineColor: color.accent }),
    textFrame(bounds, styles, {
      x: x + 14,
      y: y + 8,
      width: width - 28,
      height: 22,
      lines: [{ text: laneInfo.name, fontPx: 14, color: "#22313f", bold: true }],
      align: "left",
    }),
    textFrame(bounds, styles, {
      x: x + 14,
      y: y + 32,
      width: width - 28,
      height: 18,
      lines: [{ text: `${laneInfo.id} / ${laneInfo.type}`, fontPx: 10, color: "#657784", bold: true }],
      align: "left",
    }),
    "</draw:g>",
  ].join("");
}

/** ノード1個分の図形と、コネクタの接着先になる図形IDを返す */
function buildNodeShapes(node: Node<FlowNodeData>, bounds: DiagramBounds, styles: StyleRegistry, nextId: () => string) {
  const flowNode = node.data.node;
  const width = NODE_WIDTH_BY_TYPE[flowNode.type];
  const height = NODE_HEIGHT_BY_TYPE[flowNode.type];
  const x = node.position.x;
  const y = node.position.y;
  const anchorId = nextId();
  const glue = gluePointsXml(width, height);

  if (flowNode.type === "decision") {
    const style = styles.graphic(
      `draw:fill="solid" draw:fill-color="#fff3cf" draw:stroke="solid" svg:stroke-color="#c99d34" svg:stroke-width="${inch(1)}" draw:textarea-vertical-align="middle" fo:padding-left="0.02in" fo:padding-right="0.02in"`,
    );
    const para = styles.paragraph(paragraphProps("center", 12, "#43340e", true));
    const w = Math.round(width * MM100_PER_PX);
    const h = Math.round(height * MM100_PER_PX);
    return {
      anchorId,
      xml: [
        `<draw:polygon draw:id="${anchorId}" xml:id="${anchorId}" draw:style-name="${style}" svg:x="${inch(x - bounds.x)}" svg:y="${inch(y - bounds.y)}" svg:width="${inch(width)}" svg:height="${inch(height)}" svg:viewBox="0 0 ${w} ${h}" draw:points="${Math.round(w / 2)},0 ${w},${Math.round(h / 2)} ${Math.round(w / 2)},${h} 0,${Math.round(h / 2)}">`,
        glue,
        `<text:p text:style-name="${para}">${escapeXml(flowNode.label)}</text:p>`,
        "</draw:polygon>",
      ].join(""),
    };
  }

  if (flowNode.type === "start" || flowNode.type === "end") {
    const fill = flowNode.type === "start" ? "#2f8f6f" : "#714d91";
    const style = styles.graphic(
      `draw:fill="solid" draw:fill-color="${fill}" draw:stroke="solid" svg:stroke-color="${fill}" svg:stroke-width="${inch(1)}" draw:textarea-vertical-align="middle"`,
    );
    const para = styles.paragraph(paragraphProps("center", 14, "#ffffff", true));
    return {
      anchorId,
      xml: [
        `<draw:rect draw:id="${anchorId}" xml:id="${anchorId}" draw:style-name="${style}" svg:x="${inch(x - bounds.x)}" svg:y="${inch(y - bounds.y)}" svg:width="${inch(width)}" svg:height="${inch(height)}" draw:corner-radius="${inch(height / 2)}">`,
        glue,
        `<text:p text:style-name="${para}">${escapeXml(flowNode.label)}</text:p>`,
        "</draw:rect>",
      ].join(""),
    };
  }

  // process / document / system_process: グループ(本体・アクセント・テキスト)。
  // グルーポイントは本体矩形に定義し、グループ移動でコネクタが追従する
  const accent = flowNode.type === "document" ? "#9d6d1f" : flowNode.type === "system_process" ? "#2f8f6f" : "#2f6f8f";
  const bodyStyle = styles.graphic(
    `draw:fill="solid" draw:fill-color="#ffffff" draw:stroke="solid" svg:stroke-color="#bccbd4" svg:stroke-width="${inch(1)}" draw:textarea-vertical-align="middle"`,
  );
  const xml = [
    "<draw:g>",
    `<draw:rect draw:id="${anchorId}" xml:id="${anchorId}" draw:style-name="${bodyStyle}" svg:x="${inch(x - bounds.x)}" svg:y="${inch(y - bounds.y)}" svg:width="${inch(width)}" svg:height="${inch(height)}" draw:corner-radius="${inch(8)}">`,
    glue,
    "</draw:rect>",
    rect(bounds, styles, { x, y, width: 5, height, fill: accent, lineColor: accent }),
    textFrame(bounds, styles, {
      x: x + 12,
      y: y + 4,
      width: width - 20,
      height: 16,
      lines: [{ text: `${node.data.laneName} / ${node.data.phaseName}`, fontPx: 10, color: "#667b88", bold: true }],
      align: "left",
    }),
    textFrame(bounds, styles, {
      x: x + 12,
      y: y + 24,
      width: width - 20,
      height: flowNode.description ? 34 : height - 28,
      lines: [{ text: flowNode.label, fontPx: 13, color: "#17212b", bold: true }],
      align: "left",
      verticalAlign: "top",
    }),
    flowNode.description
      ? textFrame(bounds, styles, {
          x: x + 12,
          y: y + 58,
          width: width - 20,
          height: height - 62,
          lines: [{ text: flowNode.description, fontPx: 10, color: "#667784", bold: false }],
          align: "left",
          verticalAlign: "top",
        })
      : "",
    "</draw:g>",
  ].join("");

  return { anchorId, xml };
}

/**
 * グルーポイント定義。並びは画面・Excel・VSDXと同一(仕様S5-2):
 * 上(ANCHOR_PERCENTS順) → 下(同) → 左(SIDE_ANCHOR_OFFSETS順) → 右(同)。
 * IDは4番から(0-3は既定の辺中央)。座標はdraw:align="top-left"基準の絶対長:
 * LibreOfficeは%指定のグルーポイントを解釈せず中心にフォールバックするため。
 */
function gluePointsXml(widthPx: number, heightPx: number) {
  const points: string[] = [];
  const add = (xPx: number, yPx: number, escape: string) => {
    points.push(
      `<draw:glue-point draw:id="${4 + points.length}" svg:x="${inch(xPx)}" svg:y="${inch(yPx)}" draw:align="top-left" draw:escape-direction="${escape}"/>`,
    );
  };
  ANCHOR_PERCENTS.forEach((percent) => add(widthPx * percent, 0, "up"));
  ANCHOR_PERCENTS.forEach((percent) => add(widthPx * percent, heightPx, "down"));
  SIDE_ANCHOR_OFFSETS.forEach((offset) => add(0, heightPx / 2 + offset, "left"));
  SIDE_ANCHOR_OFFSETS.forEach((offset) => add(widthPx, heightPx / 2 + offset, "right"));
  return points.join("");
}

const CONNECTION_SITE_BASE: Record<EdgeAnchorInfo["side"], number> = {
  top: 0,
  bottom: ANCHOR_PERCENTS.length,
  left: ANCHOR_PERCENTS.length * 2,
  right: ANCHOR_PERCENTS.length * 2 + SIDE_ANCHOR_OFFSETS.length,
};

function anchorSiteIndex(anchor: EdgeAnchorInfo | undefined, handleId: string | null | undefined, fallback: number) {
  if (anchor) {
    const slotMax = (anchor.side === "top" || anchor.side === "bottom" ? ANCHOR_PERCENTS.length : SIDE_ANCHOR_OFFSETS.length) - 1;
    return CONNECTION_SITE_BASE[anchor.side] + Math.min(Math.max(anchor.slot, 0), slotMax);
  }
  const side = handleId?.split("-")[1] as EdgeAnchorInfo["side"] | undefined;
  return side && side in CONNECTION_SITE_BASE ? CONNECTION_SITE_BASE[side] : fallback;
}

/** エッジ: Draw純正コネクタ。両端をノードのグルーポイントに接着する */
function buildConnector(
  edge: FlowExportContext["edges"][number],
  bounds: DiagramBounds,
  styles: StyleRegistry,
  anchorIdByNodeId: Map<string, string>,
) {
  const data = edge.data;
  if (!data?.routePath?.length) return null;
  const points = data.routePath.filter((point, index) => {
    const previous = data.routePath?.[index - 1];
    return !previous || previous.x !== point.x || previous.y !== point.y;
  });
  if (points.length < 2) return null;

  const edgeType = data.edge.edge_type;
  const color = edgeType === "rollback" ? "#d94841" : edgeType === "exception" ? "#b26a00" : edgeType === "escalation" ? "#6f4bb2" : "#2f6f8f";
  const strokePx = edgeType === "rollback" || edgeType === "exception" ? 2.6 : 2;
  const dashed = edgeType === "rollback";
  const style = styles.graphic(
    [
      'draw:fill="none"',
      `draw:stroke="${dashed ? "dash" : "solid"}"`,
      dashed ? 'draw:stroke-dash="Dash"' : "",
      `svg:stroke-color="${color}"`,
      `svg:stroke-width="${inch(strokePx)}"`,
      'draw:marker-end="Arrow"',
      `draw:marker-end-width="${inch(9)}"`,
      'draw:marker-end-center="false"',
    ]
      .filter(Boolean)
      .join(" "),
  );

  const begin = points[0];
  const end = points[points.length - 1];
  const startId = anchorIdByNodeId.get(edge.source);
  const endId = anchorIdByNodeId.get(edge.target);
  const startGlue = 4 + anchorSiteIndex(data.sourceAnchor, edge.sourceHandle, CONNECTION_SITE_BASE.bottom);
  const endGlue = 4 + anchorSiteIndex(data.targetAnchor, edge.targetHandle, CONNECTION_SITE_BASE.top);

  // 初期経路: バウンディングボックス原点基準の1/100mm座標
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));
  const viewW = Math.max(1, Math.round((maxX - minX) * MM100_PER_PX));
  const viewH = Math.max(1, Math.round((maxY - minY) * MM100_PER_PX));
  const path = points
    .map((point, index) => {
      const px = Math.round((point.x - minX) * MM100_PER_PX);
      const py = Math.round((point.y - minY) * MM100_PER_PX);
      return `${index === 0 ? "M" : "L"} ${px} ${py}`;
    })
    .join(" ");

  return [
    `<draw:connector draw:style-name="${style}" draw:type="standard"`,
    ` svg:x1="${inch(begin.x - bounds.x)}" svg:y1="${inch(begin.y - bounds.y)}"`,
    ` svg:x2="${inch(end.x - bounds.x)}" svg:y2="${inch(end.y - bounds.y)}"`,
    startId ? ` draw:start-shape="${startId}" draw:start-glue-point="${startGlue}"` : "",
    endId ? ` draw:end-shape="${endId}" draw:end-glue-point="${endGlue}"` : "",
    ` svg:viewBox="0 0 ${viewW} ${viewH}" svg:d="${path}"/>`,
  ].join("");
}

function buildEdgeLabel(edge: FlowExportContext["edges"][number], bounds: DiagramBounds, styles: StyleRegistry) {
  const data = edge.data;
  const label = edge.label ? String(edge.label) : "";
  if (!data?.routePath?.length || !label) return null;
  const first = data.routePath[0];
  const last = data.routePath[data.routePath.length - 1];
  const labelPoint = data.labelPoint ?? { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 };
  const widthPx = Math.max(30, textWidthPx(label, 12) + 10);
  const heightPx = 18;

  return textFrame(bounds, styles, {
    x: labelPoint.x - widthPx / 2,
    y: labelPoint.y - heightPx / 2,
    width: widthPx,
    height: heightPx,
    lines: [{ text: label, fontPx: 12, color: "#22313f", bold: true }],
    align: "center",
    fill: "#ffffff",
    noWrap: true,
  });
}

type RectSpec = {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  lineColor: string;
  roundingPx?: number;
};

function rect(bounds: DiagramBounds, styles: StyleRegistry, spec: RectSpec) {
  const style = styles.graphic(
    `draw:fill="solid" draw:fill-color="${spec.fill}" draw:stroke="solid" svg:stroke-color="${spec.lineColor}" svg:stroke-width="${inch(1)}"`,
  );
  const rounding = spec.roundingPx ? ` draw:corner-radius="${inch(spec.roundingPx)}"` : "";
  return `<draw:rect draw:style-name="${style}" svg:x="${inch(spec.x - bounds.x)}" svg:y="${inch(spec.y - bounds.y)}" svg:width="${inch(spec.width)}" svg:height="${inch(spec.height)}"${rounding}/>`;
}

type TextLine = { text: string; fontPx: number; color: string; bold: boolean };

type TextFrameSpec = {
  x: number;
  y: number;
  width: number;
  height: number;
  lines: TextLine[];
  align: "left" | "center";
  verticalAlign?: "top" | "middle";
  fill?: string;
  noWrap?: boolean;
};

function textFrame(bounds: DiagramBounds, styles: StyleRegistry, spec: TextFrameSpec) {
  const style = styles.graphic(
    [
      spec.fill ? `draw:fill="solid" draw:fill-color="${spec.fill}"` : 'draw:fill="none"',
      'draw:stroke="none"',
      `draw:textarea-vertical-align="${spec.verticalAlign ?? "middle"}"`,
      'draw:auto-grow-height="false"',
      spec.noWrap ? 'fo:wrap-option="no-wrap"' : "",
      'fo:padding-left="0in" fo:padding-right="0in" fo:padding-top="0in" fo:padding-bottom="0in"',
    ]
      .filter(Boolean)
      .join(" "),
  );
  const paragraphs = spec.lines
    .map((line) => {
      const para = styles.paragraph(paragraphProps(spec.align, line.fontPx, line.color, line.bold));
      return `<text:p text:style-name="${para}">${escapeXml(line.text)}</text:p>`;
    })
    .join("");
  return [
    `<draw:frame draw:style-name="${style}" svg:x="${inch(spec.x - bounds.x)}" svg:y="${inch(spec.y - bounds.y)}" svg:width="${inch(spec.width)}" svg:height="${inch(spec.height)}">`,
    `<draw:text-box>${paragraphs}</draw:text-box>`,
    "</draw:frame>",
  ].join("");
}

function paragraphProps(align: "left" | "center", fontPx: number, color: string, bold: boolean) {
  // 日本語はアジア文字用属性(*-asian)が適用されるため、西欧用と両方指定する
  const size = `${round2(fontPx * 0.75)}pt`;
  const weight = bold ? "bold" : "normal";
  return [
    `<style:paragraph-properties fo:text-align="${align === "left" ? "start" : "center"}"/>`,
    `<style:text-properties style:font-name="${FONT_JA}" style:font-name-asian="${FONT_JA}" style:font-name-complex="${FONT_JA}" fo:color="${color}" fo:font-size="${size}" style:font-size-asian="${size}" style:font-size-complex="${size}" fo:font-weight="${weight}" style:font-weight-asian="${weight}" style:font-weight-complex="${weight}"/>`,
  ].join("");
}

function inch(px: number) {
  return `${Math.round((px / PX_PER_INCH) * 1e4) / 1e4}in`;
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function textWidthPx(value: string, fontPx: number) {
  let width = 0;
  for (const char of value) {
    width += char.charCodeAt(0) > 0xff ? fontPx : fontPx * 0.55;
  }
  return width;
}

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
