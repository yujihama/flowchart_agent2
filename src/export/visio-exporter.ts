import type { Node } from "@xyflow/react";
import type { FlowNodeData, LaneNodeData } from "../layout/flow-reactflow-types";
import {
  LANE_HEADER_HEIGHT,
  LANE_PALETTE,
  LANE_WIDTH,
  NODE_HEIGHT_BY_TYPE,
  NODE_WIDTH_BY_TYPE,
} from "../layout/swimlane-constants";
import type { FlowExportContext } from "./flow-exporters";
import { zipStore } from "./zip-store";

/**
 * Visio (.vsdx) エクスポート。
 *
 * VSDXはOPC(ZIP+XML)パッケージで、ページ上の図形を
 * http://schemas.microsoft.com/office/visio/2012/main 名前空間のXMLで表す。
 * 座標系は左下原点・インチ単位(画面pxは96dpi換算)。
 *
 * v1の方針: レイアウトエンジンが確定した経路(routePath)を忠実に再現するため、
 * エッジは経路そのままのポリライン図形として出力する(矢印・破線・色は再現)。
 * ノードを動かすと線が追従する「動的コネクタ」化は、Dynamic Connectorマスターの
 * 埋め込みが必要なため将来拡張とする。
 */

const VISIO_NS = "http://schemas.microsoft.com/office/visio/2012/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PX_PER_INCH = 96;

const FONT_JA = "Yu Gothic UI";

type Point = { x: number; y: number };

export function createVsdxBlob(context: FlowExportContext) {
  const files = buildVsdxFiles(context);
  return new Blob([zipStore(files)], { type: "application/vnd.ms-visio.drawing" });
}

/** テスト・スクリプトから直接ZIPバイト列を得るための入口 */
export function createVsdxBytes(context: FlowExportContext) {
  return zipStore(buildVsdxFiles(context));
}

function buildVsdxFiles({ model, nodes, edges }: FlowExportContext) {
  const bounds = getDiagramBounds(nodes, edges);
  const page = buildPageXml({ model, nodes, edges }, bounds);
  const files = new Map<string, string | Uint8Array>();

  files.set("[Content_Types].xml", contentTypesXml());
  files.set("_rels/.rels", packageRelsXml());
  files.set("docProps/core.xml", coreXml(model.title));
  files.set("docProps/app.xml", appXml());
  files.set("visio/document.xml", documentXml());
  files.set("visio/_rels/document.xml.rels", documentRelsXml());
  files.set("visio/pages/pages.xml", pagesXml(bounds));
  files.set("visio/pages/_rels/pages.xml.rels", pagesRelsXml());
  files.set("visio/pages/page1.xml", page);

  return files;
}

function contentTypesXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/visio/document.xml" ContentType="application/vnd.ms-visio.drawing.main+xml"/>',
    '<Override PartName="/visio/pages/pages.xml" ContentType="application/vnd.ms-visio.pages+xml"/>',
    '<Override PartName="/visio/pages/page1.xml" ContentType="application/vnd.ms-visio.page+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    "</Types>",
  ].join("");
}

function packageRelsXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/document" Target="visio/document.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>',
    "</Relationships>",
  ].join("");
}

function coreXml(title: string) {
  const now = new Date().toISOString();
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `<dc:title>${escapeXml(title)}</dc:title>`,
    "<dc:creator>Flowchart Export</dc:creator>",
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>`,
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>`,
    "</cp:coreProperties>",
  ].join("");
}

function appXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">',
    "<Application>Flowchart Export</Application>",
    "</Properties>",
  ].join("");
}

function documentXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<VisioDocument xmlns="${VISIO_NS}" xmlns:r="${REL_NS}" xml:space="preserve">`,
    '<DocumentSettings TopPage="0" DefaultTextStyle="0" DefaultLineStyle="0" DefaultFillStyle="0" DefaultGuideStyle="0"/>',
    "<StyleSheets>",
    '<StyleSheet ID="0" NameU="No Style" Name="No Style">',
    '<Cell N="EnableLineProps" V="1"/>',
    '<Cell N="EnableFillProps" V="1"/>',
    '<Cell N="EnableTextProps" V="1"/>',
    '<Cell N="LineWeight" V="0.01041666666666667"/>',
    '<Cell N="LineColor" V="#000000"/>',
    '<Cell N="LinePattern" V="1"/>',
    '<Cell N="LineCap" V="0"/>',
    '<Cell N="BeginArrow" V="0"/>',
    '<Cell N="EndArrow" V="0"/>',
    '<Cell N="BeginArrowSize" V="2"/>',
    '<Cell N="EndArrowSize" V="2"/>',
    '<Cell N="FillForegnd" V="#ffffff"/>',
    '<Cell N="FillPattern" V="1"/>',
    '<Cell N="VerticalAlign" V="1"/>',
    '<Cell N="LeftMargin" V="0.02"/>',
    '<Cell N="RightMargin" V="0.02"/>',
    '<Cell N="TopMargin" V="0.02"/>',
    '<Cell N="BottomMargin" V="0.02"/>',
    `<Section N="Character"><Row IX="0"><Cell N="Font" V="${FONT_JA}"/><Cell N="Color" V="#000000"/><Cell N="Size" V="0.1527777777777778"/></Row></Section>`,
    '<Section N="Paragraph"><Row IX="0"><Cell N="HorzAlign" V="1"/></Row></Section>',
    "</StyleSheet>",
    "</StyleSheets>",
    "</VisioDocument>",
  ].join("");
}

function documentRelsXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/pages" Target="pages/pages.xml"/>',
    "</Relationships>",
  ].join("");
}

function pagesXml(bounds: DiagramBounds) {
  const widthIn = toIn(bounds.width);
  const heightIn = toIn(bounds.height);
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<Pages xmlns="${VISIO_NS}" xmlns:r="${REL_NS}" xml:space="preserve">`,
    '<Page ID="0" NameU="Page-1" Name="Page-1">',
    '<PageSheet LineStyle="0" FillStyle="0" TextStyle="0">',
    `<Cell N="PageWidth" V="${widthIn}"/>`,
    `<Cell N="PageHeight" V="${heightIn}"/>`,
    '<Cell N="PageScale" V="1" U="IN_F"/>',
    '<Cell N="DrawingScale" V="1" U="IN_F"/>',
    "</PageSheet>",
    '<Rel r:id="rId1"/>',
    "</Page>",
    "</Pages>",
  ].join("");
}

function pagesRelsXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/page" Target="page1.xml"/>',
    "</Relationships>",
  ].join("");
}

type DiagramBounds = { x: number; y: number; width: number; height: number };

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

function buildPageXml({ model, nodes, edges }: FlowExportContext, bounds: DiagramBounds) {
  const shapes: string[] = [];
  let shapeId = 0;
  const nextId = () => {
    shapeId += 1;
    return shapeId;
  };
  const laneNodes = nodes.filter((node): node is Node<LaneNodeData> => node.data.kind === "lane");
  const flowNodes = nodes.filter((node): node is Node<FlowNodeData> => node.data.kind === "flow");

  laneNodes.forEach((lane) => shapes.push(...buildLaneShapes(lane, bounds, nextId)));
  edges.forEach((edge) => {
    const shape = buildEdgeShape(edge, bounds, nextId);
    if (shape) shapes.push(shape);
  });
  flowNodes.forEach((node) => shapes.push(...buildNodeShapes(node, bounds, nextId)));
  edges.forEach((edge) => {
    const label = buildEdgeLabelShape(edge, bounds, nextId);
    if (label) shapes.push(label);
  });
  shapes.push(
    textShape(nextId(), bounds, {
      x: bounds.x + 20,
      y: bounds.y + bounds.height - 26,
      width: 300,
      height: 16,
      text: model.flow_id,
      fontPx: 11,
      color: "#657784",
      bold: false,
      align: "left",
    }),
  );

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<PageContents xmlns="${VISIO_NS}" xmlns:r="${REL_NS}" xml:space="preserve">`,
    "<Shapes>",
    ...shapes,
    "</Shapes>",
    "</PageContents>",
  ].join("");
}

/** レーン背景・ヘッダー・タイトル(3〜4図形) */
function buildLaneShapes(lane: Node<LaneNodeData>, bounds: DiagramBounds, nextId: () => number) {
  const { lane: laneInfo, laneIndex, height, width = LANE_WIDTH } = lane.data;
  const color = LANE_PALETTE[laneIndex % LANE_PALETTE.length];
  const x = lane.position.x;
  const y = lane.position.y;

  return [
    rectShape(nextId(), bounds, { x, y, width, height, fill: color.fill, lineColor: "#c8d4dc" }),
    rectShape(nextId(), bounds, { x, y, width, height: LANE_HEADER_HEIGHT, fill: color.header, lineColor: "#c8d4dc" }),
    rectShape(nextId(), bounds, { x, y, width: 5, height: LANE_HEADER_HEIGHT, fill: color.accent, lineColor: color.accent }),
    textShape(nextId(), bounds, {
      x: x + 14,
      y: y + 8,
      width: width - 28,
      height: LANE_HEADER_HEIGHT - 16,
      text: `${laneInfo.name}\n${laneInfo.id} / ${laneInfo.type}`,
      runs: [
        { fontPx: 14, color: "#22313f", bold: true },
        { fontPx: 10, color: "#657784", bold: true },
      ],
      align: "left",
    }),
  ];
}

function buildNodeShapes(node: Node<FlowNodeData>, bounds: DiagramBounds, nextId: () => number) {
  const flowNode = node.data.node;
  const width = NODE_WIDTH_BY_TYPE[flowNode.type];
  const height = NODE_HEIGHT_BY_TYPE[flowNode.type];
  const x = node.position.x;
  const y = node.position.y;

  if (flowNode.type === "decision") {
    return [
      diamondShape(nextId(), bounds, {
        x,
        y,
        width,
        height,
        fill: "#fff3cf",
        lineColor: "#c99d34",
        text: flowNode.label,
        fontPx: 12,
        color: "#43340e",
      }),
    ];
  }

  if (flowNode.type === "start" || flowNode.type === "end") {
    const fill = flowNode.type === "start" ? "#2f8f6f" : "#714d91";
    return [
      rectShape(nextId(), bounds, {
        x,
        y,
        width,
        height,
        fill,
        lineColor: fill,
        roundingPx: height / 2,
        text: flowNode.label,
        fontPx: 14,
        color: "#ffffff",
        bold: true,
      }),
    ];
  }

  const accent = flowNode.type === "document" ? "#9d6d1f" : flowNode.type === "system_process" ? "#2f8f6f" : "#2f6f8f";
  const caption = `${node.data.laneName} / ${node.data.phaseName}`;
  const body = flowNode.description ? `${flowNode.label}\n${flowNode.description}` : flowNode.label;
  return [
    rectShape(nextId(), bounds, { x, y, width, height, fill: "#ffffff", lineColor: "#bccbd4", roundingPx: 8 }),
    rectShape(nextId(), bounds, { x, y, width: 5, height, fill: accent, lineColor: accent }),
    textShape(nextId(), bounds, {
      x: x + 12,
      y: y + 6,
      width: width - 20,
      height: height - 12,
      text: `${caption}\n${body}`,
      runs: flowNode.description
        ? [
            { fontPx: 10, color: "#667b88", bold: true },
            { fontPx: 13, color: "#17212b", bold: true },
            { fontPx: 10, color: "#667784", bold: false },
          ]
        : [
            { fontPx: 10, color: "#667b88", bold: true },
            { fontPx: 13, color: "#17212b", bold: true },
          ],
      align: "left",
    }),
  ];
}

/** エッジ本体: routePathをそのまま辿るポリライン図形 */
function buildEdgeShape(edge: FlowExportContext["edges"][number], bounds: DiagramBounds, nextId: () => number) {
  const data = edge.data;
  if (!data?.routePath?.length) return null;
  const points = compactPoints(data.routePath);
  if (points.length < 2) return null;

  const edgeType = data.edge.edge_type;
  const color = edgeType === "rollback" ? "#d94841" : edgeType === "exception" ? "#b26a00" : edgeType === "escalation" ? "#6f4bb2" : "#2f6f8f";
  const strokePx = edgeType === "rollback" || edgeType === "exception" ? 2.6 : 2;
  const dashed = edgeType === "rollback";

  // バウンディングボックスを0.5pxずつ広げ、垂直/水平のみの経路でも幅・高さが0にならないようにする
  const minX = Math.min(...points.map((point) => point.x)) - 0.5;
  const maxX = Math.max(...points.map((point) => point.x)) + 0.5;
  const minY = Math.min(...points.map((point) => point.y)) - 0.5;
  const maxY = Math.max(...points.map((point) => point.y)) + 0.5;
  const widthIn = toIn(maxX - minX);
  const heightIn = toIn(maxY - minY);
  const pin = pagePoint({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 }, bounds);

  const rows = points
    .map((point, index) => {
      const localX = toIn(point.x - minX);
      const localY = toIn(maxY - point.y);
      const type = index === 0 ? "MoveTo" : "LineTo";
      return `<Row T="${type}" IX="${index + 1}"><Cell N="X" V="${localX}"/><Cell N="Y" V="${localY}"/></Row>`;
    })
    .join("");

  return [
    `<Shape ID="${nextId()}" NameU="edge ${escapeXml(data.edge.id)}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">`,
    `<Cell N="PinX" V="${pin.x}"/>`,
    `<Cell N="PinY" V="${pin.y}"/>`,
    `<Cell N="Width" V="${widthIn}"/>`,
    `<Cell N="Height" V="${heightIn}"/>`,
    `<Cell N="LocPinX" V="${div2(widthIn)}" F="Width*0.5"/>`,
    `<Cell N="LocPinY" V="${div2(heightIn)}" F="Height*0.5"/>`,
    `<Cell N="LineColor" V="${color}"/>`,
    `<Cell N="LineWeight" V="${toIn(strokePx)}"/>`,
    `<Cell N="LinePattern" V="${dashed ? 2 : 1}"/>`,
    '<Cell N="EndArrow" V="4"/>',
    '<Cell N="EndArrowSize" V="1"/>',
    '<Cell N="LineCap" V="1"/>',
    '<Section N="Geometry" IX="0">',
    '<Cell N="NoFill" V="1"/>',
    '<Cell N="NoLine" V="0"/>',
    rows,
    "</Section>",
    "</Shape>",
  ].join("");
}

function buildEdgeLabelShape(edge: FlowExportContext["edges"][number], bounds: DiagramBounds, nextId: () => number) {
  const data = edge.data;
  const label = edge.label ? String(edge.label) : "";
  if (!data?.routePath?.length || !label) return null;
  const first = data.routePath[0];
  const last = data.routePath[data.routePath.length - 1];
  const labelPoint = data.labelPoint ?? { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 };
  const widthPx = Math.max(30, textWidthPx(label, 12) + 10);
  const heightPx = 18;

  return textShape(nextId(), bounds, {
    x: labelPoint.x - widthPx / 2,
    y: labelPoint.y - heightPx / 2,
    width: widthPx,
    height: heightPx,
    text: label,
    fontPx: 12,
    color: "#22313f",
    bold: true,
    align: "center",
    fill: "#ffffff",
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
  text?: string;
  fontPx?: number;
  color?: string;
  bold?: boolean;
};

function rectShape(id: number, bounds: DiagramBounds, spec: RectSpec) {
  const geometry = [
    '<Section N="Geometry" IX="0">',
    '<Cell N="NoFill" V="0"/>',
    '<Cell N="NoLine" V="0"/>',
    '<Row T="RelMoveTo" IX="1"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row>',
    '<Row T="RelLineTo" IX="2"><Cell N="X" V="1"/><Cell N="Y" V="0"/></Row>',
    '<Row T="RelLineTo" IX="3"><Cell N="X" V="1"/><Cell N="Y" V="1"/></Row>',
    '<Row T="RelLineTo" IX="4"><Cell N="X" V="0"/><Cell N="Y" V="1"/></Row>',
    '<Row T="RelLineTo" IX="5"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row>',
    "</Section>",
  ].join("");
  const character = spec.text
    ? `<Section N="Character"><Row IX="0"><Cell N="Font" V="${FONT_JA}"/><Cell N="Color" V="${spec.color ?? "#17212b"}"/><Cell N="Size" V="${fontSizeIn(spec.fontPx ?? 12)}"/><Cell N="Style" V="${spec.bold ? 1 : 0}"/></Row></Section>`
    : "";

  return [
    `<Shape ID="${id}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">`,
    frameCells(spec, bounds),
    `<Cell N="FillForegnd" V="${spec.fill}"/>`,
    `<Cell N="LineColor" V="${spec.lineColor}"/>`,
    '<Cell N="LineWeight" V="0.01041666666666667"/>',
    spec.roundingPx ? `<Cell N="Rounding" V="${toIn(spec.roundingPx)}"/>` : "",
    geometry,
    character,
    spec.text ? `<Text>${escapeXml(spec.text)}</Text>` : "",
    "</Shape>",
  ].join("");
}

type DiamondSpec = RectSpec;

function diamondShape(id: number, bounds: DiagramBounds, spec: DiamondSpec) {
  const geometry = [
    '<Section N="Geometry" IX="0">',
    '<Cell N="NoFill" V="0"/>',
    '<Cell N="NoLine" V="0"/>',
    '<Row T="RelMoveTo" IX="1"><Cell N="X" V="0.5"/><Cell N="Y" V="0"/></Row>',
    '<Row T="RelLineTo" IX="2"><Cell N="X" V="1"/><Cell N="Y" V="0.5"/></Row>',
    '<Row T="RelLineTo" IX="3"><Cell N="X" V="0.5"/><Cell N="Y" V="1"/></Row>',
    '<Row T="RelLineTo" IX="4"><Cell N="X" V="0"/><Cell N="Y" V="0.5"/></Row>',
    '<Row T="RelLineTo" IX="5"><Cell N="X" V="0.5"/><Cell N="Y" V="0"/></Row>',
    "</Section>",
  ].join("");
  const character = `<Section N="Character"><Row IX="0"><Cell N="Font" V="${FONT_JA}"/><Cell N="Color" V="${spec.color ?? "#43340e"}"/><Cell N="Size" V="${fontSizeIn(spec.fontPx ?? 12)}"/><Cell N="Style" V="1"/></Row></Section>`;

  return [
    `<Shape ID="${id}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">`,
    frameCells(spec, bounds),
    `<Cell N="FillForegnd" V="${spec.fill}"/>`,
    `<Cell N="LineColor" V="${spec.lineColor}"/>`,
    '<Cell N="LineWeight" V="0.01041666666666667"/>',
    geometry,
    character,
    spec.text ? `<Text>${escapeXml(spec.text)}</Text>` : "",
    "</Shape>",
  ].join("");
}

type TextRun = { fontPx: number; color: string; bold: boolean };

type TextSpec = {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  fontPx?: number;
  color?: string;
  bold?: boolean;
  align: "left" | "center";
  fill?: string;
  /** 改行区切りの各行に別書式を適用する場合に指定(行数と同数) */
  runs?: TextRun[];
};

function textShape(id: number, bounds: DiagramBounds, spec: TextSpec) {
  const horzAlign = spec.align === "left" ? 0 : 1;
  const lines = spec.text.split("\n");
  const runs = spec.runs && spec.runs.length === lines.length ? spec.runs : null;
  const character = runs
    ? `<Section N="Character">${runs
        .map(
          (run, index) =>
            `<Row IX="${index}"><Cell N="Font" V="${FONT_JA}"/><Cell N="Color" V="${run.color}"/><Cell N="Size" V="${fontSizeIn(run.fontPx)}"/><Cell N="Style" V="${run.bold ? 1 : 0}"/></Row>`,
        )
        .join("")}</Section>`
    : `<Section N="Character"><Row IX="0"><Cell N="Font" V="${FONT_JA}"/><Cell N="Color" V="${spec.color ?? "#17212b"}"/><Cell N="Size" V="${fontSizeIn(spec.fontPx ?? 12)}"/><Cell N="Style" V="${spec.bold ? 1 : 0}"/></Row></Section>`;
  const text = runs
    ? `<Text>${lines.map((line, index) => `<cp IX="${index}"/>${escapeXml(line)}${index < lines.length - 1 ? "\n" : ""}`).join("")}</Text>`
    : `<Text>${escapeXml(spec.text)}</Text>`;
  const geometry = spec.fill
    ? [
        '<Section N="Geometry" IX="0">',
        '<Cell N="NoFill" V="0"/>',
        '<Cell N="NoLine" V="1"/>',
        '<Row T="RelMoveTo" IX="1"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row>',
        '<Row T="RelLineTo" IX="2"><Cell N="X" V="1"/><Cell N="Y" V="0"/></Row>',
        '<Row T="RelLineTo" IX="3"><Cell N="X" V="1"/><Cell N="Y" V="1"/></Row>',
        '<Row T="RelLineTo" IX="4"><Cell N="X" V="0"/><Cell N="Y" V="1"/></Row>',
        '<Row T="RelLineTo" IX="5"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row>',
        "</Section>",
      ].join("")
    : '<Section N="Geometry" IX="0"><Cell N="NoFill" V="1"/><Cell N="NoLine" V="1"/><Cell N="NoShow" V="1"/><Row T="RelMoveTo" IX="1"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row><Row T="RelLineTo" IX="2"><Cell N="X" V="1"/><Cell N="Y" V="1"/></Row></Section>';

  return [
    `<Shape ID="${id}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">`,
    frameCells(spec, bounds),
    spec.fill ? `<Cell N="FillForegnd" V="${spec.fill}"/>` : '<Cell N="FillPattern" V="0"/>',
    '<Cell N="LinePattern" V="0"/>',
    geometry,
    character,
    `<Section N="Paragraph"><Row IX="0"><Cell N="HorzAlign" V="${horzAlign}"/></Row></Section>`,
    text,
    "</Shape>",
  ].join("");
}

/** PinX/PinY/Width/Height/LocPin の共通セル(page座標px→インチ・Y反転) */
function frameCells(spec: { x: number; y: number; width: number; height: number }, bounds: DiagramBounds) {
  const widthIn = toIn(spec.width);
  const heightIn = toIn(spec.height);
  const pin = pagePoint({ x: spec.x + spec.width / 2, y: spec.y + spec.height / 2 }, bounds);
  return [
    `<Cell N="PinX" V="${pin.x}"/>`,
    `<Cell N="PinY" V="${pin.y}"/>`,
    `<Cell N="Width" V="${widthIn}"/>`,
    `<Cell N="Height" V="${heightIn}"/>`,
    `<Cell N="LocPinX" V="${div2(widthIn)}" F="Width*0.5"/>`,
    `<Cell N="LocPinY" V="${div2(heightIn)}" F="Height*0.5"/>`,
  ].join("");
}

/** 画面px座標(左上原点・Y下向き)→Visioページ座標(左下原点・インチ) */
function pagePoint(point: Point, bounds: DiagramBounds) {
  return {
    x: toIn(point.x - bounds.x),
    y: toIn(bounds.y + bounds.height - point.y),
  };
}

function toIn(px: number) {
  return roundIn(px / PX_PER_INCH);
}

/** 画面フォントpx→Visioの文字サイズ(インチ)。1px = 0.75pt、1pt = 1/72in */
function fontSizeIn(px: number) {
  return roundIn((px * 0.75) / 72);
}

function div2(value: number) {
  return roundIn(value / 2);
}

function roundIn(value: number) {
  return Math.round(value * 1e6) / 1e6;
}

function textWidthPx(value: string, fontPx: number) {
  let width = 0;
  for (const char of value) {
    width += char.charCodeAt(0) > 0xff ? fontPx : fontPx * 0.55;
  }
  return width;
}

function compactPoints(points: Point[]) {
  return points.filter((point, index) => {
    const previous = points[index - 1];
    return !previous || previous.x !== point.x || previous.y !== point.y;
  });
}

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
