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
 * Visio (.vsdx) エクスポート。
 *
 * VSDXはOPC(ZIP+XML)パッケージで、ページ上の図形を
 * http://schemas.microsoft.com/office/visio/2012/main 名前空間のXMLで表す。
 * 座標系は左下原点・インチ単位(画面pxは96dpi換算)。
 *
 * エッジは1Dコネクタ図形として出力し、初期形状にはレイアウトエンジンが確定した
 * 経路(routePath)をそのまま与える。両端はノードの接続点(画面と同じアンカー並び)へ
 * Connect要素でグルーするため、Visio本体ではノード移動時にエッジが追従して
 * 再ルーティングされる(移動後の経路はVisioのルーティングエンジンによる)。
 * LibreOffice(libvisio)は数式・グルーを評価しないため静的表示のまま変わらない。
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
  files.set("docProps/custom.xml", customXml());
  files.set("visio/document.xml", documentXml());
  files.set("visio/_rels/document.xml.rels", documentRelsXml());
  files.set("visio/windows.xml", windowsXml(bounds));
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
    '<Override PartName="/visio/windows.xml" ContentType="application/vnd.ms-visio.windows+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>',
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
    '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/>',
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

/** Visio外で生成したファイルのため、開いた時に全式の再計算を指示する(公式推奨) */
function customXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">',
    '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="RecalcDocument"><vt:bool>true</vt:bool></property>',
    "</Properties>",
  ].join("");
}

function windowsXml(bounds: DiagramBounds) {
  const centerX = div2(toIn(bounds.width));
  const centerY = div2(toIn(bounds.height));
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<Windows xmlns="${VISIO_NS}" xmlns:r="${REL_NS}" ClientWidth="1600" ClientHeight="900" xml:space="preserve">`,
    `<Window ID="0" WindowType="Drawing" WindowState="1073741824" ContainerType="Page" Page="0" ViewScale="0.5" ViewCenterX="${centerX}" ViewCenterY="${centerY}">`,
    "<ShowRulers>1</ShowRulers>",
    "<ShowGrid>1</ShowGrid>",
    "<ShowPageBreaks>0</ShowPageBreaks>",
    "<ShowGuides>1</ShowGuides>",
    "<ShowConnectionPoints>0</ShowConnectionPoints>",
    "<GlueSettings>9</GlueSettings>",
    "<SnapSettings>65847</SnapSettings>",
    "<SnapExtensions>34</SnapExtensions>",
    "<SnapAngles/>",
    "<DynamicGridEnabled>1</DynamicGridEnabled>",
    "<TabSplitterPos>0.5</TabSplitterPos>",
    "</Window>",
    "</Windows>",
  ].join("");
}

function documentXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<VisioDocument xmlns="${VISIO_NS}" xmlns:r="${REL_NS}" xml:space="preserve">`,
    '<DocumentSettings TopPage="0" DefaultTextStyle="0" DefaultLineStyle="0" DefaultFillStyle="0" DefaultGuideStyle="0">',
    "<GlueSettings>9</GlueSettings>",
    "<SnapSettings>65847</SnapSettings>",
    "<SnapExtensions>34</SnapExtensions>",
    "<SnapAngles/>",
    "<DynamicGridEnabled>1</DynamicGridEnabled>",
    "<ProtectStyles>0</ProtectStyles>",
    "<ProtectShapes>0</ProtectShapes>",
    "<ProtectMasters>0</ProtectMasters>",
    "<ProtectBkgnds>0</ProtectBkgnds>",
    "</DocumentSettings>",
    "<StyleSheets>",
    '<StyleSheet ID="0" NameU="No Style" IsCustomNameU="1" Name="No Style" IsCustomName="1">',
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
    '<Relationship Id="rId2" Type="http://schemas.microsoft.com/visio/2010/relationships/windows" Target="windows.xml"/>',
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
  let shapeId = 0;
  const nextId = () => {
    shapeId += 1;
    return shapeId;
  };
  const laneNodes = nodes.filter((node): node is Node<LaneNodeData> => node.data.kind === "lane");
  const flowNodes = nodes.filter((node): node is Node<FlowNodeData> => node.data.kind === "flow");

  // ノードを先に構築してグルー先の図形IDを確定させる(描画順はエッジの上)
  const nodeShapeIdByNodeId = new Map<string, number>();
  const nodeXml: string[] = [];
  flowNodes.forEach((node) => {
    const built = buildNodeShapes(node, bounds, nextId);
    nodeShapeIdByNodeId.set(node.id, built.anchorShapeId);
    nodeXml.push(...built.xml);
  });

  const laneXml = laneNodes.flatMap((lane) => buildLaneShapes(lane, bounds, nextId));
  const connects: string[] = [];
  const edgeXml = edges
    .map((edge) => buildEdgeShape(edge, bounds, nextId, nodeShapeIdByNodeId, connects))
    .filter((shape): shape is string => shape !== null);
  const labelXml = edges
    .map((edge) => buildEdgeLabelShape(edge, bounds, nextId))
    .filter((shape): shape is string => shape !== null);
  const footer = textShape(nextId(), bounds, {
    x: bounds.x + 20,
    y: bounds.y + bounds.height - 26,
    width: 300,
    height: 16,
    text: model.flow_id,
    fontPx: 11,
    color: "#657784",
    bold: false,
    align: "left",
  });

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<PageContents xmlns="${VISIO_NS}" xmlns:r="${REL_NS}" xml:space="preserve">`,
    "<Shapes>",
    ...laneXml,
    ...edgeXml,
    ...nodeXml,
    ...labelXml,
    footer,
    "</Shapes>",
    connects.length ? `<Connects>${connects.join("")}</Connects>` : "",
    "</PageContents>",
  ].join("");
}

/**
 * レーン一式(背景・ヘッダー・アクセント・タイトル)を1グループにまとめる。
 * テキストは単一書式の子図形に分ける: libvisioは複数書式ラン(cp)の文字数を
 * バイト数で誤計算するため、日本語では書式境界がずれる。
 */
function buildLaneShapes(lane: Node<LaneNodeData>, bounds: DiagramBounds, nextId: () => number) {
  const { lane: laneInfo, laneIndex, height, width = LANE_WIDTH } = lane.data;
  const color = LANE_PALETTE[laneIndex % LANE_PALETTE.length];
  const x = lane.position.x;
  const y = lane.position.y;
  const groupId = nextId();

  return [
    [
      `<Shape ID="${groupId}" NameU="lane ${escapeXml(laneInfo.id)}" Type="Group" LineStyle="0" FillStyle="0" TextStyle="0">`,
      frameCells({ x, y, width, height }, bounds),
      '<Cell N="LinePattern" V="0"/>',
      '<Cell N="FillPattern" V="0"/>',
      '<Cell N="DisplayMode" V="2"/>',
      "<Shapes>",
      childRectShape(nextId(), 0, 0, width, height, height, { fill: color.fill, lineColor: "#c8d4dc" }),
      childRectShape(nextId(), 0, 0, width, LANE_HEADER_HEIGHT, height, { fill: color.header, lineColor: "#c8d4dc" }),
      childRectShape(nextId(), 0, 0, 5, LANE_HEADER_HEIGHT, height, { fill: color.accent, lineColor: color.accent }),
      childTextShape(nextId(), 14, 8, width - 28, 22, height, {
        text: laneInfo.name,
        fontPx: 14,
        color: "#22313f",
        bold: true,
        align: "left",
      }),
      childTextShape(nextId(), 14, 32, width - 28, 18, height, {
        text: `${laneInfo.id} / ${laneInfo.type}`,
        fontPx: 10,
        color: "#657784",
        bold: true,
        align: "left",
      }),
      "</Shapes>",
      "</Shape>",
    ].join(""),
  ];
}

/** ノード1個分の図形群と、エッジのグルー先になる図形IDを返す */
function buildNodeShapes(node: Node<FlowNodeData>, bounds: DiagramBounds, nextId: () => number) {
  const flowNode = node.data.node;
  const width = NODE_WIDTH_BY_TYPE[flowNode.type];
  const height = NODE_HEIGHT_BY_TYPE[flowNode.type];
  const x = node.position.x;
  const y = node.position.y;
  const connection = connectionSectionXml(width, height);

  if (flowNode.type === "decision") {
    const id = nextId();
    return {
      anchorShapeId: id,
      xml: [
        diamondShape(id, bounds, {
          x,
          y,
          width,
          height,
          fill: "#fff3cf",
          lineColor: "#c99d34",
          text: flowNode.label,
          fontPx: 12,
          color: "#43340e",
          extraSectionXml: connection,
          objType: 1,
        }),
      ],
    };
  }

  if (flowNode.type === "start" || flowNode.type === "end") {
    const fill = flowNode.type === "start" ? "#2f8f6f" : "#714d91";
    const id = nextId();
    return {
      anchorShapeId: id,
      xml: [
        rectShape(id, bounds, {
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
          extraSectionXml: connection,
          objType: 1,
        }),
      ],
    };
  }

  // process / document / system_process: 本体矩形・アクセントバー・テキストを
  // 1グループにまとめて1オブジェクトで扱えるようにする。テキストは単一書式の
  // 子図形に分ける(複数書式ランはlibvisioが日本語で誤描画するため)
  const accent = flowNode.type === "document" ? "#9d6d1f" : flowNode.type === "system_process" ? "#2f8f6f" : "#2f6f8f";
  const caption = `${node.data.laneName} / ${node.data.phaseName}`;
  const groupId = nextId();
  const xml = [
    `<Shape ID="${groupId}" NameU="node ${escapeXml(flowNode.id)}" Type="Group" LineStyle="0" FillStyle="0" TextStyle="0">`,
    frameCells({ x, y, width, height }, bounds),
    '<Cell N="LinePattern" V="0"/>',
    '<Cell N="FillPattern" V="0"/>',
    '<Cell N="DisplayMode" V="2"/>',
    '<Cell N="ObjType" V="1"/>',
    connection,
    "<Shapes>",
    childRectShape(nextId(), 0, 0, width, height, height, { fill: "#ffffff", lineColor: "#bccbd4", roundingPx: 8 }),
    childRectShape(nextId(), 0, 0, 5, height, height, { fill: accent, lineColor: accent }),
    childTextShape(nextId(), 12, 4, width - 20, 16, height, {
      text: caption,
      fontPx: 10,
      color: "#667b88",
      bold: true,
      align: "left",
    }),
    childTextShape(nextId(), 12, 24, width - 20, flowNode.description ? 34 : height - 28, height, {
      text: flowNode.label,
      fontPx: 13,
      color: "#17212b",
      bold: true,
      align: "left",
      verticalAlign: 0,
    }),
    flowNode.description
      ? childTextShape(nextId(), 12, 58, width - 20, height - 62, height, {
          text: flowNode.description,
          fontPx: 10,
          color: "#667784",
          bold: false,
          align: "left",
          verticalAlign: 0,
        })
      : "",
    "</Shapes>",
    "</Shape>",
  ].join("");

  return { anchorShapeId: groupId, xml: [xml] };
}

/** グループ内の子矩形(親ローカル座標) */
function childRectShape(
  id: number,
  x: number,
  y: number,
  width: number,
  height: number,
  parentHeightPx: number,
  spec: { fill: string; lineColor: string; roundingPx?: number },
) {
  return [
    `<Shape ID="${id}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">`,
    childFrameCells(x, y, width, height, parentHeightPx),
    `<Cell N="FillForegnd" V="${vc(spec.fill)}"/>`,
    `<Cell N="LineColor" V="${vc(spec.lineColor)}"/>`,
    '<Cell N="LineWeight" V="0.01041666666666667"/>',
    spec.roundingPx ? `<Cell N="Rounding" V="${toIn(spec.roundingPx)}"/>` : "",
    rectGeometryXml(),
    "</Shape>",
  ].join("");
}

/** グループ内の子テキスト(親ローカル座標・単一書式) */
function childTextShape(
  id: number,
  x: number,
  y: number,
  width: number,
  height: number,
  parentHeightPx: number,
  content: TextContent & { align: "left" | "center" },
) {
  const textParts = textPartsXml(content);
  return [
    `<Shape ID="${id}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">`,
    childFrameCells(x, y, width, height, parentHeightPx),
    '<Cell N="FillPattern" V="0"/>',
    '<Cell N="LinePattern" V="0"/>',
    textParts.cells,
    rectGeometryXml({ noShow: true }),
    textParts.sections,
    textParts.text,
    "</Shape>",
  ].join("");
}

/**
 * エッジ本体: 1Dコネクタ図形。初期ジオメトリは画面の経路をそのまま持ち、
 * 両端はノードの接続点へグルー(Connect要素+PAR(PNT)数式)する。
 * Visioで開くとノード移動に追従する。libvisioは数式を無視し初期形状を描く。
 */
function buildEdgeShape(
  edge: FlowExportContext["edges"][number],
  bounds: DiagramBounds,
  nextId: () => number,
  nodeShapeIdByNodeId: Map<string, number>,
  connects: string[],
) {
  const data = edge.data;
  if (!data?.routePath?.length) return null;
  const points = compactPoints(data.routePath);
  if (points.length < 2) return null;

  const edgeType = data.edge.edge_type;
  const color = edgeType === "rollback" ? "#d94841" : edgeType === "exception" ? "#b26a00" : edgeType === "escalation" ? "#6f4bb2" : "#2f6f8f";
  const strokePx = edgeType === "rollback" || edgeType === "exception" ? 2.6 : 2;
  const dashed = edgeType === "rollback";

  const shapeId = nextId();
  const begin = pagePoint(points[0], bounds);
  const end = pagePoint(points[points.length - 1], bounds);
  const widthIn = roundIn(end.x - begin.x);
  const heightIn = roundIn(end.y - begin.y);

  // ローカル座標(原点=始点)。Width/Heightは符号付きで終点が(Width,Height)になる
  const rows = points
    .map((point, index) => {
      const page = pagePoint(point, bounds);
      const type = index === 0 ? "MoveTo" : "LineTo";
      return `<Row T="${type}" IX="${index + 1}"><Cell N="X" V="${roundIn(page.x - begin.x)}"/><Cell N="Y" V="${roundIn(page.y - begin.y)}"/></Row>`;
    })
    .join("");

  const sourceShapeId = nodeShapeIdByNodeId.get(edge.source);
  const targetShapeId = nodeShapeIdByNodeId.get(edge.target);
  const sourceSite = anchorSiteIndex(data.sourceAnchor, edge.sourceHandle, CONNECTION_SITE_BASE.bottom);
  const targetSite = anchorSiteIndex(data.targetAnchor, edge.targetHandle, CONNECTION_SITE_BASE.top);
  const beginGlue =
    sourceShapeId !== undefined
      ? ` F="PAR(PNT(Sheet.${sourceShapeId}!Connections.X${sourceSite + 1},Sheet.${sourceShapeId}!Connections.Y${sourceSite + 1}))"`
      : "";
  const endGlue =
    targetShapeId !== undefined
      ? ` F="PAR(PNT(Sheet.${targetShapeId}!Connections.X${targetSite + 1},Sheet.${targetShapeId}!Connections.Y${targetSite + 1}))"`
      : "";
  if (sourceShapeId !== undefined) {
    connects.push(
      `<Connect FromSheet="${shapeId}" FromCell="BeginX" FromPart="9" ToSheet="${sourceShapeId}" ToCell="Connections.X${sourceSite + 1}" ToPart="${100 + sourceSite}"/>`,
    );
  }
  if (targetShapeId !== undefined) {
    connects.push(
      `<Connect FromSheet="${shapeId}" FromCell="EndX" FromPart="12" ToSheet="${targetShapeId}" ToCell="Connections.X${targetSite + 1}" ToPart="${100 + targetSite}"/>`,
    );
  }

  return [
    `<Shape ID="${shapeId}" NameU="edge ${escapeXml(data.edge.id)}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">`,
    `<Cell N="BeginX" V="${begin.x}"${beginGlue}/>`,
    `<Cell N="BeginY" V="${begin.y}"${beginGlue}/>`,
    `<Cell N="EndX" V="${end.x}"${endGlue}/>`,
    `<Cell N="EndY" V="${end.y}"${endGlue}/>`,
    `<Cell N="PinX" V="${roundIn((begin.x + end.x) / 2)}" F="GUARD((BeginX+EndX)/2)"/>`,
    `<Cell N="PinY" V="${roundIn((begin.y + end.y) / 2)}" F="GUARD((BeginY+EndY)/2)"/>`,
    `<Cell N="Width" V="${widthIn}" F="GUARD(EndX-BeginX)"/>`,
    `<Cell N="Height" V="${heightIn}" F="GUARD(EndY-BeginY)"/>`,
    `<Cell N="LocPinX" V="${div2(widthIn)}" F="GUARD(Width*0.5)"/>`,
    `<Cell N="LocPinY" V="${div2(heightIn)}" F="GUARD(Height*0.5)"/>`,
    '<Cell N="Angle" V="0" F="GUARD(0)"/>',
    sourceShapeId !== undefined ? `<Cell N="BegTrigger" V="2" F="_XFTRIGGER(Sheet.${sourceShapeId}!EventXFMod)"/>` : "",
    targetShapeId !== undefined ? `<Cell N="EndTrigger" V="2" F="_XFTRIGGER(Sheet.${targetShapeId}!EventXFMod)"/>` : "",
    '<Cell N="ObjType" V="2"/>',
    '<Cell N="ShapeRouteStyle" V="16"/>',
    '<Cell N="ConFixedCode" V="0"/>',
    `<Cell N="LineColor" V="${vc(color)}"/>`,
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

/**
 * 接続点の並びは画面・Excel出力と同一に保つこと(仕様S5-2):
 * 上(ANCHOR_PERCENTS順) → 下(同) → 左(SIDE_ANCHOR_OFFSETS順) → 右(同)。
 */
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

/** ノード外周の接続点セクション(ローカル座標・Y上向き) */
function connectionSectionXml(widthPx: number, heightPx: number) {
  const rows: string[] = [];
  const add = (xIn: number, yIn: number) => {
    rows.push(
      `<Row IX="${rows.length}"><Cell N="X" V="${xIn}"/><Cell N="Y" V="${yIn}"/><Cell N="DirX" V="0"/><Cell N="DirY" V="0"/><Cell N="Type" V="0"/><Cell N="AutoGen" V="0"/><Cell N="Prompt" V=""/></Row>`,
    );
  };
  ANCHOR_PERCENTS.forEach((percent) => add(toIn(widthPx * percent), toIn(heightPx)));
  ANCHOR_PERCENTS.forEach((percent) => add(toIn(widthPx * percent), 0));
  SIDE_ANCHOR_OFFSETS.forEach((offset) => add(0, toIn(heightPx / 2 - offset)));
  SIDE_ANCHOR_OFFSETS.forEach((offset) => add(toIn(widthPx), toIn(heightPx / 2 - offset)));
  return `<Section N="Connection">${rows.join("")}</Section>`;
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

type TextRun = { fontPx: number; color: string; bold: boolean };

type TextContent = {
  text: string;
  /**
   * 改行区切りの各行に別書式を適用する場合に指定(行数と同数)。
   * 注意: libvisioは書式ラン(cp)の文字数をバイト数で誤計算するため、
   * 日本語テキストではLibreOfficeで書式境界がずれる。日本語を含む場合は
   * 単一書式の子図形に分けること。
   */
  runs?: TextRun[];
  fontPx?: number;
  color?: string;
  bold?: boolean;
  align?: "left" | "center";
  /** 0=上揃え、1=中央(省略時はスタイル既定の中央) */
  verticalAlign?: 0 | 1;
  marginsPx?: { left?: number; top?: number; right?: number; bottom?: number };
};

/** テキストのセル(整列・余白)、セクション(Character/Paragraph)、Text要素を組み立てる */
function textPartsXml(content: TextContent | undefined) {
  if (!content?.text) return { cells: "", sections: "", text: "" };
  const lines = content.text.split("\n");
  const runs = content.runs && content.runs.length === lines.length ? content.runs : null;
  const characterRow = (run: TextRun, index: number) =>
    `<Row IX="${index}"><Cell N="Font" V="${FONT_JA}"/><Cell N="Color" V="${vc(run.color)}"/><Cell N="Size" V="${fontSizeIn(run.fontPx)}"/><Cell N="Style" V="${run.bold ? 1 : 0}"/></Row>`;
  const character = runs
    ? `<Section N="Character">${runs.map(characterRow).join("")}</Section>`
    : `<Section N="Character">${characterRow({ fontPx: content.fontPx ?? 12, color: content.color ?? "#17212b", bold: content.bold ?? false }, 0)}</Section>`;
  const paragraph = content.align
    ? `<Section N="Paragraph"><Row IX="0"><Cell N="HorzAlign" V="${content.align === "left" ? 0 : 1}"/></Row></Section>`
    : "";
  const margins = content.marginsPx;
  const cells = [
    content.verticalAlign !== undefined ? `<Cell N="VerticalAlign" V="${content.verticalAlign}"/>` : "",
    margins?.left !== undefined ? `<Cell N="LeftMargin" V="${toIn(margins.left)}"/>` : "",
    margins?.top !== undefined ? `<Cell N="TopMargin" V="${toIn(margins.top)}"/>` : "",
    margins?.right !== undefined ? `<Cell N="RightMargin" V="${toIn(margins.right)}"/>` : "",
    margins?.bottom !== undefined ? `<Cell N="BottomMargin" V="${toIn(margins.bottom)}"/>` : "",
  ].join("");
  const text = runs
    ? `<Text>${lines.map((line, index) => `<cp IX="${index}"/>${escapeXml(line)}${index < lines.length - 1 ? "\n" : ""}`).join("")}</Text>`
    : `<Text>${escapeXml(content.text)}</Text>`;
  return { cells, sections: character + paragraph, text };
}

function rectGeometryXml(options?: { noLine?: boolean; noShow?: boolean }) {
  return [
    '<Section N="Geometry" IX="0">',
    `<Cell N="NoFill" V="${options?.noShow ? 1 : 0}"/>`,
    `<Cell N="NoLine" V="${options?.noLine || options?.noShow ? 1 : 0}"/>`,
    options?.noShow ? '<Cell N="NoShow" V="1"/>' : "",
    '<Row T="RelMoveTo" IX="1"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row>',
    '<Row T="RelLineTo" IX="2"><Cell N="X" V="1"/><Cell N="Y" V="0"/></Row>',
    '<Row T="RelLineTo" IX="3"><Cell N="X" V="1"/><Cell N="Y" V="1"/></Row>',
    '<Row T="RelLineTo" IX="4"><Cell N="X" V="0"/><Cell N="Y" V="1"/></Row>',
    '<Row T="RelLineTo" IX="5"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row>',
    "</Section>",
  ].join("");
}

type RectSpec = Omit<TextContent, "text"> & {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  lineColor: string;
  roundingPx?: number;
  extraSectionXml?: string;
  objType?: number;
  text?: string;
};

function rectShape(id: number, bounds: DiagramBounds, spec: RectSpec) {
  const textParts = textPartsXml(spec.text ? { ...spec, text: spec.text } : undefined);

  return [
    `<Shape ID="${id}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">`,
    frameCells(spec, bounds),
    `<Cell N="FillForegnd" V="${vc(spec.fill)}"/>`,
    `<Cell N="LineColor" V="${vc(spec.lineColor)}"/>`,
    '<Cell N="LineWeight" V="0.01041666666666667"/>',
    spec.roundingPx ? `<Cell N="Rounding" V="${toIn(spec.roundingPx)}"/>` : "",
    spec.objType !== undefined ? `<Cell N="ObjType" V="${spec.objType}"/>` : "",
    textParts.cells,
    rectGeometryXml(),
    spec.extraSectionXml ?? "",
    textParts.sections,
    textParts.text,
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
  const textParts = textPartsXml(spec.text ? { ...spec, text: spec.text, bold: spec.bold ?? true, color: spec.color ?? "#43340e" } : undefined);

  return [
    `<Shape ID="${id}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">`,
    frameCells(spec, bounds),
    `<Cell N="FillForegnd" V="${vc(spec.fill)}"/>`,
    `<Cell N="LineColor" V="${vc(spec.lineColor)}"/>`,
    '<Cell N="LineWeight" V="0.01041666666666667"/>',
    spec.objType !== undefined ? `<Cell N="ObjType" V="${spec.objType}"/>` : "",
    textParts.cells,
    geometry,
    spec.extraSectionXml ?? "",
    textParts.sections,
    textParts.text,
    "</Shape>",
  ].join("");
}

type TextSpec = TextContent & {
  x: number;
  y: number;
  width: number;
  height: number;
  align: "left" | "center";
  fill?: string;
};

function textShape(id: number, bounds: DiagramBounds, spec: TextSpec) {
  const textParts = textPartsXml(spec);

  return [
    `<Shape ID="${id}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">`,
    frameCells(spec, bounds),
    spec.fill ? `<Cell N="FillForegnd" V="${vc(spec.fill)}"/>` : '<Cell N="FillPattern" V="0"/>',
    '<Cell N="LinePattern" V="0"/>',
    textParts.cells,
    spec.fill ? rectGeometryXml({ noLine: true }) : rectGeometryXml({ noShow: true }),
    textParts.sections,
    textParts.text,
    "</Shape>",
  ].join("");
}

/** グループ内子図形のXFormセル(親ローカル座標、x/yは親の左上からのpxオフセット) */
function childFrameCells(x: number, y: number, width: number, height: number, parentHeightPx: number) {
  const widthIn = toIn(width);
  const heightIn = toIn(height);
  return [
    `<Cell N="PinX" V="${toIn(x + width / 2)}"/>`,
    `<Cell N="PinY" V="${toIn(parentHeightPx - (y + height / 2))}"/>`,
    `<Cell N="Width" V="${widthIn}"/>`,
    `<Cell N="Height" V="${heightIn}"/>`,
    `<Cell N="LocPinX" V="${div2(widthIn)}" F="Width*0.5"/>`,
    `<Cell N="LocPinY" V="${div2(heightIn)}" F="Height*0.5"/>`,
    '<Cell N="Angle" V="0"/>',
    '<Cell N="FlipX" V="0"/>',
    '<Cell N="FlipY" V="0"/>',
    '<Cell N="ResizeMode" V="0"/>',
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
    '<Cell N="Angle" V="0"/>',
    '<Cell N="FlipX" V="0"/>',
    '<Cell N="FlipY" V="0"/>',
    '<Cell N="ResizeMode" V="0"/>',
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

function vc(hex: string) {
  return hex.toUpperCase();
}

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
