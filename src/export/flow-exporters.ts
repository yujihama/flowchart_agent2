import type { Edge, Node } from "@xyflow/react";
import type { FlowModel } from "../domain/flow-model";
import type { EdgeAnchorInfo, FlowEdgeData, FlowNodeData, LaneNodeData } from "../layout/flow-reactflow-types";
import {
  ANCHOR_PERCENTS,
  LANE_PALETTE,
  LANE_WIDTH,
  NODE_HEIGHT_BY_TYPE,
  NODE_WIDTH_BY_TYPE,
  SIDE_ANCHOR_OFFSETS,
} from "../layout/swimlane-constants";

type ExportNode = Node<FlowNodeData | LaneNodeData>;
type ExportEdge = Edge<FlowEdgeData>;

export type FlowExportFormatId = "png" | "svg" | "xlsx";

type FlowExportContext = {
  model: FlowModel;
  nodes: ExportNode[];
  edges: ExportEdge[];
};

type FlowExportFormat = {
  id: FlowExportFormatId;
  label: string;
  extension: string;
  mimeType: string;
  buildBlob: (context: FlowExportContext) => Promise<Blob>;
};

export const FLOW_EXPORT_FORMATS: FlowExportFormat[] = [
  {
    id: "png",
    label: "PNG",
    extension: "png",
    mimeType: "image/png",
    buildBlob: async (context) => svgToPngBlob(renderFlowSvg(context)),
  },
  {
    id: "svg",
    label: "SVG",
    extension: "svg",
    mimeType: "image/svg+xml;charset=utf-8",
    buildBlob: async (context) => new Blob([renderFlowSvg(context)], { type: "image/svg+xml;charset=utf-8" }),
  },
  {
    id: "xlsx",
    label: "XLSX",
    extension: "xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buildBlob: async (context) => createXlsxBlob(context),
  },
];

export async function createFlowExportBlob(formatId: FlowExportFormatId, context: FlowExportContext) {
  const format = FLOW_EXPORT_FORMATS.find((item) => item.id === formatId);
  if (!format) {
    throw new Error(`Unknown export format: ${formatId}`);
  }

  return format.buildBlob(context);
}

export function createFlowExportFilename(formatId: FlowExportFormatId, model: FlowModel) {
  const format = FLOW_EXPORT_FORMATS.find((item) => item.id === formatId);
  const extension = format?.extension ?? formatId;
  return `${fileSafeName(model.title || model.flow_id)}.${extension}`;
}

function renderFlowSvg({ model, nodes, edges }: FlowExportContext) {
  const bounds = getExportBounds(nodes, edges);
  const flowNodes = nodes.filter((node): node is Node<FlowNodeData> => node.data.kind === "flow");
  const laneNodes = nodes.filter((node): node is Node<LaneNodeData> => node.data.kind === "lane");
  const width = bounds.width;
  const height = bounds.height;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${bounds.x} ${bounds.y} ${width} ${height}">`,
    "<defs>",
    marker("arrow-normal", "#2f6f8f"),
    marker("arrow-rollback", "#d94841"),
    marker("arrow-exception", "#b26a00"),
    marker("arrow-escalation", "#6f4bb2"),
    "</defs>",
    `<rect x="${bounds.x}" y="${bounds.y}" width="${width}" height="${height}" fill="#eef2f5"/>`,
    ...laneNodes.map(renderLane),
    ...edges.map(renderEdge),
    ...flowNodes.map(renderFlowNode),
    `<text x="${bounds.x + 20}" y="${bounds.y + height - 18}" fill="#657784" font-family="${fontFamily()}" font-size="11">${escapeXml(model.flow_id)}</text>`,
    "</svg>",
  ].join("");
}

function renderLane(node: Node<LaneNodeData>) {
  const { lane, laneIndex, height, width = LANE_WIDTH } = node.data;
  const color = LANE_PALETTE[laneIndex % LANE_PALETTE.length];
  const x = node.position.x;
  const y = node.position.y;

  return [
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${color.fill}" stroke="#c8d4dc"/>`,
    `<rect x="${x}" y="${y}" width="${width}" height="62" fill="${color.header}" stroke="#c8d4dc"/>`,
    `<rect x="${x}" y="${y}" width="5" height="62" fill="${color.accent}"/>`,
    `<rect x="${x + 16}" y="${y + 19}" width="40" height="24" rx="12" fill="${color.chip}"/>`,
    `<text x="${x + 36}" y="${y + 35}" text-anchor="middle" dominant-baseline="central" fill="${color.accent}" font-family="${fontFamily()}" font-size="10" font-weight="800">${escapeXml(lane.id)}</text>`,
    `<text x="${x + 64}" y="${y + 26}" fill="#22313f" font-family="${fontFamily()}" font-size="14" font-weight="800">${escapeXml(lane.name)}</text>`,
    `<text x="${x + 64}" y="${y + 45}" fill="#657784" font-family="${fontFamily()}" font-size="10" font-weight="700">${escapeXml(lane.type)}</text>`,
  ].join("");
}

function renderFlowNode(node: Node<FlowNodeData>) {
  const flowNode = node.data.node;
  const width = NODE_WIDTH_BY_TYPE[flowNode.type];
  const height = NODE_HEIGHT_BY_TYPE[flowNode.type];
  const x = node.position.x;
  const y = node.position.y;

  if (flowNode.type === "decision") {
    const labelLines = wrapText(flowNode.label, 13, 3);
    return [
      `<polygon points="${x + width / 2},${y} ${x + width},${y + height / 2} ${x + width / 2},${y + height} ${x},${y + height / 2}" fill="#fff3cf" stroke="#c99d34"/>`,
      ...renderTextLines(labelLines, x + width / 2, y + height / 2, 14, "#43340e", 12, "middle", "800"),
    ].join("");
  }

  if (flowNode.type === "start" || flowNode.type === "end") {
    const fill = flowNode.type === "start" ? "#2f8f6f" : "#714d91";
    return [
      `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${height / 2}" fill="${fill}"/>`,
      `<text x="${x + width / 2}" y="${y + height / 2}" text-anchor="middle" dominant-baseline="central" fill="#ffffff" font-family="${fontFamily()}" font-size="14" font-weight="800">${escapeXml(flowNode.label)}</text>`,
    ].join("");
  }

  const accent = flowNode.type === "document" ? "#9d6d1f" : flowNode.type === "system_process" ? "#2f8f6f" : "#2f6f8f";
  const labelLines = wrapText(flowNode.label, 14, 2);
  const descriptionLines = flowNode.description ? wrapText(flowNode.description, 24, 2) : [];
  return [
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="8" fill="#ffffff" stroke="#bccbd4"/>`,
    `<rect x="${x}" y="${y}" width="5" height="${height}" rx="2" fill="${accent}"/>`,
    `<text x="${x + 12}" y="${y + 20}" fill="#667b88" font-family="${fontFamily()}" font-size="10" font-weight="700">${escapeXml(`${node.data.laneName} / ${node.data.phaseName}`)}</text>`,
    ...renderTextLines(labelLines, x + 12, y + 42, 16, "#17212b", 14, "start", "800"),
    ...renderTextLines(descriptionLines, x + 12, y + 68, 13, "#667784", 10, "start", "400"),
  ].join("");
}

function renderEdge(edge: ExportEdge) {
  const data = edge.data;
  if (!data?.routePath?.length) return "";
  const points = orthogonalizePoints(data.routePath);

  const color = edgeColor(data.edge.edge_type);
  const strokeWidth = data.edge.edge_type === "rollback" || data.edge.edge_type === "exception" ? 2.6 : 2;
  const dash = data.edge.edge_type === "rollback" ? ' stroke-dasharray="7 5"' : "";
  const label = edge.label ? String(edge.label) : "";
  const labelPoint = data.labelPoint ?? segmentMidpoint(points);

  return [
    `<path d="${pointsToPath(points)}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"${dash} marker-end="url(#arrow-${data.edge.edge_type ?? "normal"})"/>`,
    label
      ? `<text x="${labelPoint.x}" y="${labelPoint.y}" text-anchor="middle" dominant-baseline="central" paint-order="stroke" stroke="#ffffff" stroke-width="8" stroke-linejoin="round" fill="#22313f" font-family="${fontFamily()}" font-size="12" font-weight="800">${escapeXml(label)}</text>`
      : "",
  ].join("");
}

function getExportBounds(nodes: ExportNode[], edges: ExportEdge[]) {
  const nodeBounds = nodes.flatMap((node) => {
    const width = node.data.kind === "lane" ? (node.data.width ?? LANE_WIDTH) : NODE_WIDTH_BY_TYPE[node.data.node.type];
    const height = node.data.kind === "lane" ? node.data.height : NODE_HEIGHT_BY_TYPE[node.data.node.type];
    return [
      { x: node.position.x, y: node.position.y },
      { x: node.position.x + width, y: node.position.y + height },
    ];
  });
  const edgeBounds = edges.flatMap((edge) => edge.data?.routePath ?? []);
  const points = [...nodeBounds, ...edgeBounds];
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

function marker(id: string, color: string) {
  return `<marker id="${id}" markerWidth="12" markerHeight="12" viewBox="0 0 12 12" refX="10" refY="6" orient="auto" markerUnits="strokeWidth"><path d="M 2 2 L 10 6 L 2 10 z" fill="${color}"/></marker>`;
}

function svgToPngBlob(svg: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) {
        URL.revokeObjectURL(url);
        reject(new Error("Canvas context could not be created."));
        return;
      }
      context.fillStyle = "#eef2f5";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0);
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(url);
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("PNG export failed."));
        }
      }, "image/png");
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("SVG image could not be loaded."));
    };
    image.src = url;
  });
}

type SheetSpec = {
  name: string;
  rows: Array<Array<string | number | null>>;
  widths?: number[];
  drawingXml?: string;
  autoFilter?: boolean;
};

function createXlsxBlob(context: FlowExportContext) {
  const sheets = buildWorkbookSheets(context);
  const drawingSheets = sheets
    .map((sheet, index) => ({ sheet, index }))
    .filter((item) => item.sheet.drawingXml);
  const files = new Map<string, string | Uint8Array>();

  files.set("[Content_Types].xml", contentTypesXml(sheets.length, drawingSheets.length));
  files.set("_rels/.rels", packageRelsXml());
  files.set("docProps/app.xml", appXml(sheets));
  files.set("docProps/core.xml", coreXml(context.model));
  files.set("xl/workbook.xml", workbookXml(sheets));
  files.set("xl/_rels/workbook.xml.rels", workbookRelsXml(sheets.length));
  files.set("xl/styles.xml", stylesXml());
  sheets.forEach((sheet, index) => {
    files.set(`xl/worksheets/sheet${index + 1}.xml`, worksheetXml(sheet, index + 1));
  });
  drawingSheets.forEach(({ sheet, index }, drawingIndex) => {
    files.set(`xl/worksheets/_rels/sheet${index + 1}.xml.rels`, worksheetRelsXml(drawingIndex + 1));
    files.set(`xl/drawings/drawing${drawingIndex + 1}.xml`, sheet.drawingXml ?? "");
  });

  return new Blob([zipStore(files)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function buildWorkbookSheets({ model, nodes, edges }: FlowExportContext): SheetSpec[] {
  const laneNameById = new Map(model.lanes.map((lane) => [lane.id, lane.name]));
  const phaseNameById = new Map(model.phases.map((phase) => [phase.id, phase.name]));
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const layoutNodeById = new Map(nodes.filter((node) => node.data.kind === "flow").map((node) => [node.id, node]));

  const diagram: SheetSpec = {
    name: "フロー図",
    widths: Array.from({ length: 26 }, () => 10),
    autoFilter: false,
    drawingXml: renderExcelDrawing({ model, nodes, edges }),
    rows: [["画面のフロー図をExcel図形オブジェクトとして再現しています。"]],
  };

  const overview: SheetSpec = {
    name: "概要",
    widths: [24, 72],
    rows: [
      ["項目", "値"],
      ["タイトル", model.title],
      ["説明", model.description ?? ""],
      ["フローID", model.flow_id],
      ["スキーマバージョン", model.schema_version],
      ["レーン数", model.lanes.length],
      ["フェーズ数", model.phases.length],
      ["ノード数", model.nodes.length],
      ["エッジ数", model.edges.length],
      ["出典数", model.sources?.length ?? 0],
    ],
  };

  const lanes: SheetSpec = {
    name: "レーン",
    widths: [24, 36, 24],
    rows: [["id", "name", "type"], ...model.lanes.map((lane) => [lane.id, lane.name, lane.type])],
  };

  const phases: SheetSpec = {
    name: "フェーズ",
    widths: [24, 40],
    rows: [["id", "name"], ...model.phases.map((phase) => [phase.id, phase.name])],
  };

  const flowNodes: SheetSpec = {
    name: "ノード",
    widths: [24, 18, 36, 24, 36, 24, 36, 56, 28, 12, 12],
    rows: [
      ["id", "type", "label", "lane_id", "lane_name", "phase_id", "phase_name", "description", "source_refs", "x", "y"],
      ...model.nodes.map((node) => {
        const layoutNode = layoutNodeById.get(node.id);
        return [
          node.id,
          node.type,
          node.label,
          node.lane_id,
          laneNameById.get(node.lane_id) ?? "",
          node.phase_id,
          phaseNameById.get(node.phase_id) ?? "",
          node.description ?? "",
          joinRefs(node.source_refs),
          layoutNode ? Math.round(layoutNode.position.x) : "",
          layoutNode ? Math.round(layoutNode.position.y) : "",
        ];
      }),
    ],
  };

  const edgeSheet: SheetSpec = {
    name: "エッジ",
    widths: [24, 24, 36, 24, 36, 28, 18, 44, 28],
    rows: [
      ["id", "from", "from_label", "to", "to_label", "label", "edge_type", "condition", "source_refs"],
      ...model.edges.map((edge) => [
        edge.id,
        edge.from,
        nodeById.get(edge.from)?.label ?? "",
        edge.to,
        nodeById.get(edge.to)?.label ?? "",
        edge.label ?? "",
        edge.edge_type ?? "normal",
        edge.condition?.text ?? "",
        joinRefs(edge.source_refs),
      ]),
    ],
  };

  const sources: SheetSpec = {
    name: "出典",
    widths: [24, 36, 12, 28, 80],
    rows: [
      ["id", "file_name", "page", "section", "quote"],
      ...(model.sources ?? []).map((source) => [
        source.id,
        source.file_name,
        source.page ?? "",
        source.section ?? "",
        source.quote ?? "",
      ]),
    ],
  };

  return [diagram, overview, lanes, phases, flowNodes, edgeSheet, sources];
}

function renderExcelDrawing({ nodes, edges }: FlowExportContext) {
  const laneNodes = nodes.filter((node): node is Node<LaneNodeData> => node.data.kind === "lane");
  const flowNodes = nodes.filter((node): node is Node<FlowNodeData> => node.data.kind === "flow");
  let shapeId = 1;
  const nextId = () => {
    shapeId += 1;
    return shapeId;
  };
  const items: string[] = [];

  laneNodes.forEach((node) => {
    const { lane, laneIndex, height, width = LANE_WIDTH } = node.data;
    const color = LANE_PALETTE[laneIndex % LANE_PALETTE.length];
    const x = diagramX(node.position.x);
    const y = diagramY(node.position.y);
    const w = diagramSize(width);
    const h = diagramSize(height);
    items.push(shapeXml(nextId(), `lane-${lane.id}`, "rect", x, y, w, h, color.fill, "#c8d4dc"));
    items.push(shapeXml(nextId(), `lane-header-${lane.id}`, "rect", x, y, w, diagramSize(62), color.header, "#c8d4dc"));
    items.push(
      shapeXml(
        nextId(),
        `lane-label-${lane.id}`,
        "rect",
        x + diagramSize(12),
        y + diagramSize(10),
        w - diagramSize(24),
        diagramSize(42),
        color.header,
        color.header,
        `${lane.name}\n${lane.type}`,
        { fontSize: 10, bold: true, fontColor: "#22313f" },
      ),
    );
  });

  const nodeShapeIdByNodeId = new Map(flowNodes.map((node) => [node.id, nextId()]));

  flowNodes.forEach((node) => {
    const flowNode = node.data.node;
    const width = NODE_WIDTH_BY_TYPE[flowNode.type];
    const height = NODE_HEIGHT_BY_TYPE[flowNode.type];
    const x = diagramX(node.position.x);
    const y = diagramY(node.position.y);
    const w = diagramSize(width);
    const h = diagramSize(height);
    const shapeId = nodeShapeIdByNodeId.get(node.id) ?? nextId();

    if (flowNode.type === "decision") {
      items.push(nodeShapeXml(shapeId, flowNode.id, "diamond", x, y, w, h, "#fff3cf", "#c99d34", flowNode.label, {
        fontSize: 10,
        bold: true,
        fontColor: "#43340e",
      }));
      return;
    }

    if (flowNode.type === "start" || flowNode.type === "end") {
      items.push(
        nodeShapeXml(
          shapeId,
          flowNode.id,
          "pill",
          x,
          y,
          w,
          h,
          flowNode.type === "start" ? "#2f8f6f" : "#714d91",
          flowNode.type === "start" ? "#2f8f6f" : "#714d91",
          flowNode.label,
          { fontSize: 11, bold: true, fontColor: "#ffffff" },
        ),
      );
      return;
    }

    items.push(nodeShapeXml(shapeId, flowNode.id, "roundRect", x, y, w, h, "#ffffff", "#bccbd4", flowNode.label, {
      fontSize: 10,
      bold: true,
      fontColor: "#17212b",
    }));
  });

  edges.forEach((edge) => {
    const data = edge.data;
    if (!data?.routePath?.length) return;
    const color = edgeColor(data.edge.edge_type);
    const points = orthogonalizePoints(data.routePath);
    items.push(
      connectorXml(
        nextId(),
        `edge-${edge.id}`,
        points,
        color,
        data.edge.edge_type === "rollback",
        nodeShapeIdByNodeId.get(edge.source),
        nodeShapeIdByNodeId.get(edge.target),
        anchorSiteIndex(data.sourceAnchor, edge.sourceHandle, CONNECTION_SITE_BASE.bottom),
        anchorSiteIndex(data.targetAnchor, edge.targetHandle, CONNECTION_SITE_BASE.top),
      ),
    );
    const label = edge.label ? String(edge.label) : "";
    if (label) {
      const labelPoint = data.labelPoint ?? segmentMidpoint(points);
      // 箱をテキスト幅ぴったりに抑え、隣のエッジ線を覆わないようにする
      const box = edgeLabelBoxSize(label);
      items.push(
        shapeXml(
          nextId(),
          `edge-label-${edge.id}`,
          "roundRect",
          diagramX(labelPoint.x) - Math.round(diagramSize(box.width) / 2),
          diagramY(labelPoint.y) - Math.round(diagramSize(box.height) / 2),
          diagramSize(box.width),
          diagramSize(box.height),
          "#ffffff",
          "#ffffff",
          label,
          { fontSize: 9, bold: true, fontColor: "#22313f", tight: true },
        ),
      );
    }
  });

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">',
    ...items,
    "</xdr:wsDr>",
  ].join("");
}

type ShapeOptions = {
  fontSize?: number;
  bold?: boolean;
  fontColor?: string;
  /** 小さなラベル箱向け: 余白なし・折り返しなしで描く */
  tight?: boolean;
};

type NodeGeometryKind = "roundRect" | "pill" | "diamond";

/**
 * ノード図形本体。プリセットではなくカスタムジオメトリで出力し、UIのアンカー
 * スロットと同じ位置に接続点(cxnLst)を定義する。これによりExcel上で複数の
 * コネクタが同じ辺の別々の位置に接続でき、ノード移動後も配置が維持される。
 */
function nodeShapeXml(
  id: number,
  name: string,
  kind: NodeGeometryKind,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
  stroke: string,
  text = "",
  options: ShapeOptions = {},
) {
  return [
    `${absoluteAnchorOpen(x, y, width, height)}`,
    `<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="${id}" name="${escapeXml(name)}"/><xdr:cNvSpPr/></xdr:nvSpPr>`,
    `<xdr:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${Math.max(width, 1)}" cy="${Math.max(height, 1)}"/></a:xfrm>${nodeCustGeomXml(kind, width, height)}<a:solidFill><a:srgbClr val="${hex(fill)}"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="${hex(stroke)}"/></a:solidFill></a:ln></xdr:spPr>`,
    textBodyXml(text, options),
    "</xdr:sp><xdr:clientData/></xdr:absoluteAnchor>",
  ].join("");
}

function nodeCustGeomXml(kind: NodeGeometryKind, width: number, height: number) {
  const sites = connectionSites(kind, width, height);
  const cxnList = sites
    .map((site) => `<a:cxn ang="${site.ang}"><a:pos x="${site.x}" y="${site.y}"/></a:cxn>`)
    .join("");
  return `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst>${cxnList}</a:cxnLst><a:rect l="0" t="0" r="${width}" b="${height}"/><a:pathLst><a:path w="${width}" h="${height}">${nodePathXml(kind, width, height)}</a:path></a:pathLst></a:custGeom>`;
}

/** CONNECTION_SITE_BASE の並び(上0-4, 下5-9, 左10-14, 右15-19)で接続点を返す */
function connectionSites(kind: NodeGeometryKind, width: number, height: number) {
  const midX = Math.round(width / 2);
  const midY = Math.round(height / 2);
  const ANG = { up: 16200000, down: 5400000, left: 10800000, right: 0 };

  if (kind === "diamond") {
    // ひし形は上下左右の頂点のみが幾何学的に有効なため、全スロットを頂点に集約する
    return [
      ...ANCHOR_PERCENTS.map(() => ({ x: midX, y: 0, ang: ANG.up })),
      ...ANCHOR_PERCENTS.map(() => ({ x: midX, y: height, ang: ANG.down })),
      ...SIDE_ANCHOR_OFFSETS.map(() => ({ x: 0, y: midY, ang: ANG.left })),
      ...SIDE_ANCHOR_OFFSETS.map(() => ({ x: width, y: midY, ang: ANG.right })),
    ];
  }

  const cornerRadius = kind === "pill" ? midY : diagramSize(8);
  const sideY = (offsetPx: number) =>
    Math.min(height - cornerRadius, Math.max(cornerRadius, midY + diagramSize(offsetPx)));

  return [
    ...ANCHOR_PERCENTS.map((p) => ({ x: Math.round(width * p), y: 0, ang: ANG.up })),
    ...ANCHOR_PERCENTS.map((p) => ({ x: Math.round(width * p), y: height, ang: ANG.down })),
    ...SIDE_ANCHOR_OFFSETS.map((o) => ({ x: 0, y: kind === "pill" ? midY : sideY(o), ang: ANG.left })),
    ...SIDE_ANCHOR_OFFSETS.map((o) => ({ x: width, y: kind === "pill" ? midY : sideY(o), ang: ANG.right })),
  ];
}

function nodePathXml(kind: NodeGeometryKind, width: number, height: number) {
  const midX = Math.round(width / 2);
  const midY = Math.round(height / 2);

  if (kind === "diamond") {
    return `<a:moveTo><a:pt x="${midX}" y="0"/></a:moveTo><a:lnTo><a:pt x="${width}" y="${midY}"/></a:lnTo><a:lnTo><a:pt x="${midX}" y="${height}"/></a:lnTo><a:lnTo><a:pt x="0" y="${midY}"/></a:lnTo><a:close/>`;
  }

  const r = kind === "pill" ? midY : Math.min(diagramSize(8), midX, midY);
  const quarter = 5400000;
  return [
    `<a:moveTo><a:pt x="${r}" y="0"/></a:moveTo>`,
    `<a:lnTo><a:pt x="${width - r}" y="0"/></a:lnTo>`,
    `<a:arcTo wR="${r}" hR="${r}" stAng="16200000" swAng="${quarter}"/>`,
    `<a:lnTo><a:pt x="${width}" y="${height - r}"/></a:lnTo>`,
    `<a:arcTo wR="${r}" hR="${r}" stAng="0" swAng="${quarter}"/>`,
    `<a:lnTo><a:pt x="${r}" y="${height}"/></a:lnTo>`,
    `<a:arcTo wR="${r}" hR="${r}" stAng="${quarter}" swAng="${quarter}"/>`,
    `<a:lnTo><a:pt x="0" y="${r}"/></a:lnTo>`,
    `<a:arcTo wR="${r}" hR="${r}" stAng="10800000" swAng="${quarter}"/>`,
    `<a:close/>`,
  ].join("");
}

function shapeXml(
  id: number,
  name: string,
  preset: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
  stroke: string,
  text = "",
  options: ShapeOptions = {},
) {
  return [
    `${absoluteAnchorOpen(x, y, width, height)}`,
    `<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="${id}" name="${escapeXml(name)}"/><xdr:cNvSpPr/></xdr:nvSpPr>`,
    `<xdr:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${Math.max(width, 1)}" cy="${Math.max(height, 1)}"/></a:xfrm><a:prstGeom prst="${preset}"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${hex(fill)}"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="${hex(stroke)}"/></a:solidFill></a:ln></xdr:spPr>`,
    textBodyXml(text, options),
    "</xdr:sp><xdr:clientData/></xdr:absoluteAnchor>",
  ].join("");
}

/**
 * エッジをExcelの接続コネクタ(cxnSp)として出力する。stCxn/endCxnでノード図形の
 * 接続点に論理接続するため、Excel上でノードを動かすとコネクタが追従する。
 * 画面上の折れ線パターン(V-H-V等)をプリセットコネクタ形状+回転/反転+調整値へ
 * 変換し、初期表示も画面のルーティングを再現する。
 */
function connectorXml(
  id: number,
  name: string,
  routePoints: Array<{ x: number; y: number }>,
  color: string,
  dashed: boolean,
  sourceShapeId?: number,
  targetShapeId?: number,
  sourceCxnIdx = 2,
  targetCxnIdx = 0,
) {
  const points = orthogonalizePoints(routePoints).map((point) => ({ x: diagramX(point.x), y: diagramY(point.y) }));
  if (points.length < 2) return "";
  const geometry = connectorGeometry(points);

  const stCxn = sourceShapeId !== undefined ? `<a:stCxn id="${sourceShapeId}" idx="${sourceCxnIdx}"/>` : "";
  const endCxn = targetShapeId !== undefined ? `<a:endCxn id="${targetShapeId}" idx="${targetCxnIdx}"/>` : "";
  const rot = geometry.rot ? ` rot="${geometry.rot}"` : "";
  const flips = `${geometry.flipH ? ' flipH="1"' : ""}${geometry.flipV ? ' flipV="1"' : ""}`;
  const avList = geometry.adjustments
    .map((value, index) => `<a:gd name="adj${index + 1}" fmla="val ${value}"/>`)
    .join("");

  return [
    `${absoluteAnchorOpen(geometry.anchorX, geometry.anchorY, geometry.anchorW, geometry.anchorH)}`,
    `<xdr:cxnSp macro=""><xdr:nvCxnSpPr><xdr:cNvPr id="${id}" name="${escapeXml(name)}"/><xdr:cNvCxnSpPr>${stCxn}${endCxn}</xdr:cNvCxnSpPr></xdr:nvCxnSpPr>`,
    `<xdr:spPr><a:xfrm${rot}${flips}><a:off x="${geometry.frameX}" y="${geometry.frameY}"/><a:ext cx="${geometry.frameW}" cy="${geometry.frameH}"/></a:xfrm><a:prstGeom prst="${geometry.preset}"><a:avLst>${avList}</a:avLst></a:prstGeom><a:noFill/><a:ln w="19050"><a:solidFill><a:srgbClr val="${hex(color)}"/></a:solidFill>${dashed ? '<a:prstDash val="dash"/>' : ""}<a:tailEnd type="triangle" w="med" len="med"/></a:ln></xdr:spPr>`,
    "</xdr:cxnSp><xdr:clientData/></xdr:absoluteAnchor>",
  ].join("");
}

/**
 * ノード図形はカスタムジオメトリで各辺に複数の接続点を持つ。
 * 接続点の並び: 上(ANCHOR_PERCENTS順) → 下(同) → 左(SIDE_ANCHOR_OFFSETS順) → 右(同)。
 * レイアウトが記録したアンカー情報から対応する接続点インデックスを求める。
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

type ConnectorGeometry = {
  preset: string;
  rot: number;
  flipH: boolean;
  flipV: boolean;
  adjustments: number[];
  frameX: number;
  frameY: number;
  frameW: number;
  frameH: number;
  /** アンカー用: 回転適用後の見た目のバウンディングボックス(Excelの解釈に合わせる) */
  anchorX: number;
  anchorY: number;
  anchorW: number;
  anchorH: number;
};

/**
 * 直交折れ線をプリセットコネクタへ写像する。
 * プリセットのパスはフレーム対角(0,0)→(w,h)を結ぶため、フレームは始点・終点の
 * 外接矩形とし、途中の折れ位置は調整値(フレーム外もExcel仕様上有効)で表す。
 * 垂直始まりの形状は90度回転で表現する(Excel自身と同じ書き方)。
 */
function connectorGeometry(points: Array<{ x: number; y: number }>): ConnectorGeometry {
  const start = points[0];
  const end = points[points.length - 1];
  const minX = Math.min(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const width = Math.abs(start.x - end.x);
  const height = Math.abs(start.y - end.y);

  const signature = points
    .slice(0, -1)
    .map((point, index) => (points[index + 1].x === point.x ? "V" : "H"))
    .join("");

  const flat: ConnectorGeometry = {
    preset: "straightConnector1",
    rot: 0,
    flipH: start.x > end.x,
    flipV: start.y > end.y,
    adjustments: [],
    frameX: minX,
    frameY: minY,
    frameW: width,
    frameH: height,
    anchorX: minX,
    anchorY: minY,
    anchorW: width,
    anchorH: height,
  };

  // 90度回転フレーム: 中心を保ったまま縦横を入れ替える(アンカーは見た目のボックスのまま)
  const rotated = {
    rot: 5400000,
    flipH: false,
    flipV: start.x < end.x,
    frameX: minX + Math.round((width - height) / 2),
    frameY: minY + Math.round((height - width) / 2),
    frameW: height,
    frameH: width,
  };

  const fraction = (value: number, total: number) => (total > 0 ? Math.round((value / total) * 100000) : 50000);

  if (signature === "V" || signature === "H") {
    return flat;
  }

  if (signature === "HV") {
    return { ...flat, preset: "bentConnector2" };
  }

  if (signature === "VH") {
    return { ...flat, ...rotated, preset: "bentConnector2" };
  }

  if (signature === "HVH") {
    const jogX = points[1].x;
    const x1 = flat.flipH ? minX + width - jogX : jogX - minX;
    return { ...flat, preset: "bentConnector3", adjustments: [fraction(x1, width)] };
  }

  if (signature === "VHV") {
    const jogY = points[1].y;
    return { ...flat, ...rotated, preset: "bentConnector3", adjustments: [fraction(jogY - minY, height)] };
  }

  if (signature === "HVHV") {
    const jogX = points[1].x;
    const jogY = points[2].y;
    const x1 = flat.flipH ? minX + width - jogX : jogX - minX;
    const y1 = flat.flipV ? minY + height - jogY : jogY - minY;
    return {
      ...flat,
      preset: "bentConnector4",
      adjustments: [fraction(x1, width), fraction(y1, height)],
    };
  }

  if (signature === "VHVHV") {
    const jogAY = points[1].y;
    const jogX = points[2].x;
    const jogBY = points[3].y;
    const y2 = rotated.flipV ? jogX - minX : minX + width - jogX;
    return {
      ...flat,
      ...rotated,
      preset: "bentConnector5",
      adjustments: [fraction(jogAY - minY, height), fraction(y2, width), fraction(jogBY - minY, height)],
    };
  }

  // 想定外のパターン: 接続だけは維持し、経路はExcelの既定ルーティングに委ねる
  const startsVertical = signature.startsWith("V");
  return startsVertical
    ? { ...flat, ...rotated, preset: "bentConnector3", adjustments: [50000] }
    : { ...flat, preset: "bentConnector3", adjustments: [50000] };
}

/**
 * セルの行高・列幅に依存しないEMU絶対座標アンカー。
 * セルアンカーは実際の既定行高(フォント依存)で解釈がずれるため使わない。
 */
function absoluteAnchorOpen(x: number, y: number, width: number, height: number) {
  return `<xdr:absoluteAnchor><xdr:pos x="${Math.max(0, Math.round(x))}" y="${Math.max(0, Math.round(y))}"/><xdr:ext cx="${Math.max(1, Math.round(width))}" cy="${Math.max(1, Math.round(height))}"/>`;
}

function textBodyXml(text: string, options: ShapeOptions) {
  const fontSize = Math.round((options.fontSize ?? 10) * 100);
  const bold = options.bold ? ' b="1"' : "";
  const color = hex(options.fontColor ?? "#17212b");
  const paragraphs = text
    ? text.split("\n").map((line) => `<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="ja-JP" sz="${fontSize}"${bold}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:rPr><a:t>${escapeXml(line)}</a:t></a:r></a:p>`)
    : ["<a:p/>"];
  const bodyPr = options.tight
    ? '<a:bodyPr wrap="none" anchor="ctr" lIns="0" tIns="0" rIns="0" bIns="0"/>'
    : '<a:bodyPr wrap="square" anchor="ctr" lIns="45720" tIns="22860" rIns="45720" bIns="22860"/>';
  return `<xdr:txBody>${bodyPr}<a:lstStyle/>${paragraphs.join("")}</xdr:txBody>`;
}

/** ラベル文字列から白背景ボックスの寸法(px)を見積もる(9pt想定) */
function edgeLabelBoxSize(label: string) {
  let units = 0;
  for (const ch of label) {
    units += (ch.codePointAt(0) ?? 0) > 0xff ? 1 : 0.55;
  }
  return {
    width: Math.max(24, Math.ceil(units * 12.5) + 8),
    height: 17,
  };
}

function diagramX(value: number) {
  return toEmu(30 + value * 0.82);
}

function diagramY(value: number) {
  return toEmu(30 + value * 0.82);
}

function diagramSize(value: number) {
  return toEmu(value * 0.82);
}

function toEmu(px: number) {
  return Math.round(px * 9525);
}

function hex(color: string) {
  return color.replace("#", "").toUpperCase();
}

function contentTypesXml(sheetCount: number, drawingCount: number) {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    ...Array.from(
      { length: sheetCount },
      (_, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    ),
    ...Array.from(
      { length: drawingCount },
      (_, index) =>
        `<Override PartName="/xl/drawings/drawing${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`,
    ),
    "</Types>",
  ].join("");
}

function packageRelsXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>',
    "</Relationships>",
  ].join("");
}

function workbookRelsXml(sheetCount: number) {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    ...Array.from(
      { length: sheetCount },
      (_, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    ),
    `<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    "</Relationships>",
  ].join("");
}

function worksheetRelsXml(drawingIndex: number) {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawingIndex}.xml"/>`,
    "</Relationships>",
  ].join("");
}

function workbookXml(sheets: SheetSpec[]) {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    "<sheets>",
    ...sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`),
    "</sheets>",
    "</workbook>",
  ].join("");
}

function worksheetXml(sheet: SheetSpec, sheetIndex: number) {
  const columnCount = Math.max(...sheet.rows.map((row) => row.length), 1);
  const refs = `A1:${columnName(columnCount)}${Math.max(sheet.rows.length, 1)}`;
  const widths = sheet.widths ?? Array.from({ length: columnCount }, () => 20);
  const drawing = sheet.drawingXml ? '<drawing r:id="rId1"/>' : "";
  const autoFilter = sheet.autoFilter === false ? "" : `<autoFilter ref="${refs}"/>`;

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    `<dimension ref="${refs}"/>`,
    `<sheetViews><sheetView workbookViewId="0"${sheet.drawingXml ? ' showGridLines="0"' : ""}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`,
    "<cols>",
    ...widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`),
    "</cols>",
    "<sheetData>",
    ...sheet.rows.map((row, rowIndex) => rowXml(row, rowIndex + 1)),
    "</sheetData>",
    autoFilter,
    drawing,
    "</worksheet>",
  ].join("");
}

function rowXml(row: Array<string | number | null>, rowNumber: number) {
  const style = rowNumber === 1 ? ' s="1"' : "";
  return `<row r="${rowNumber}">${row
    .map((cell, columnIndex) => cellXml(cell, `${columnName(columnIndex + 1)}${rowNumber}`, style))
    .join("")}</row>`;
}

function cellXml(value: string | number | null, ref: string, style: string) {
  if (value === null || value === "") {
    return `<c r="${ref}"${style}/>`;
  }
  if (typeof value === "number") {
    return `<c r="${ref}"${style}><v>${value}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"${style}><is><t>${escapeXml(value)}</t></is></c>`;
}

function stylesXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<fonts count="2"><font><sz val="11"/><name val="Yu Gothic"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Yu Gothic"/></font></fonts>',
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1D5D6F"/><bgColor indexed="64"/></patternFill></fill></fills>',
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>',
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>',
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>',
    "</styleSheet>",
  ].join("");
}

function appXml(sheets: SheetSpec[]) {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">',
    "<Application>Flowchart Export</Application>",
    `<TitlesOfParts><vt:vector size="${sheets.length}" baseType="lpstr">${sheets.map((sheet) => `<vt:lpstr>${escapeXml(sheet.name)}</vt:lpstr>`).join("")}</vt:vector></TitlesOfParts>`,
    "</Properties>",
  ].join("");
}

function coreXml(model: FlowModel) {
  const now = new Date().toISOString();
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `<dc:title>${escapeXml(model.title)}</dc:title>`,
    "<dc:creator>Flowchart Export</dc:creator>",
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>`,
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>`,
    "</cp:coreProperties>",
  ].join("");
}

function zipStore(files: Map<string, string | Uint8Array>) {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const centralDirectory: Uint8Array[] = [];
  let offset = 0;

  files.forEach((content, path) => {
    const nameBytes = encoder.encode(path);
    const dataBytes = typeof content === "string" ? encoder.encode(content) : content;
    const crc = crc32(dataBytes);
    const localHeader = concatBytes([
      uint32le(0x04034b50),
      uint16le(20),
      uint16le(0x0800),
      uint16le(0),
      uint16le(0),
      uint16le(0),
      uint32le(crc),
      uint32le(dataBytes.length),
      uint32le(dataBytes.length),
      uint16le(nameBytes.length),
      uint16le(0),
      nameBytes,
    ]);
    chunks.push(localHeader, dataBytes);

    centralDirectory.push(
      concatBytes([
        uint32le(0x02014b50),
        uint16le(20),
        uint16le(20),
        uint16le(0x0800),
        uint16le(0),
        uint16le(0),
        uint16le(0),
        uint32le(crc),
        uint32le(dataBytes.length),
        uint32le(dataBytes.length),
        uint16le(nameBytes.length),
        uint16le(0),
        uint16le(0),
        uint16le(0),
        uint16le(0),
        uint32le(0),
        uint32le(offset),
        nameBytes,
      ]),
    );
    offset += localHeader.length + dataBytes.length;
  });

  const centralDirectoryOffset = offset;
  const centralDirectoryBytes = concatBytes(centralDirectory);
  const end = concatBytes([
    uint32le(0x06054b50),
    uint16le(0),
    uint16le(0),
    uint16le(files.size),
    uint16le(files.size),
    uint32le(centralDirectoryBytes.length),
    uint32le(centralDirectoryOffset),
    uint16le(0),
  ]);

  return concatBytes([...chunks, centralDirectoryBytes, end]);
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  bytes.forEach((byte) => {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  });
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16le(value: number) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function uint32le(value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function concatBytes(parts: Uint8Array[]) {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  parts.forEach((part) => {
    output.set(part, offset);
    offset += part.length;
  });
  return output;
}

function columnName(index: number) {
  let name = "";
  let current = index;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    current = Math.floor((current - 1) / 26);
  }
  return name;
}

function joinRefs(refs?: string[]) {
  return refs?.join(", ") ?? "";
}

function renderTextLines(
  lines: string[],
  x: number,
  y: number,
  lineHeight: number,
  fill: string,
  fontSize: number,
  anchor: "start" | "middle",
  weight: string,
) {
  const startY = y - ((lines.length - 1) * lineHeight) / 2;
  return lines.map(
    (line, index) =>
      `<text x="${x}" y="${startY + index * lineHeight}" text-anchor="${anchor}" dominant-baseline="central" fill="${fill}" font-family="${fontFamily()}" font-size="${fontSize}" font-weight="${weight}">${escapeXml(line)}</text>`,
  );
}

function wrapText(value: string, maxLength: number, maxLines: number) {
  const characters = Array.from(value);
  const lines: string[] = [];
  for (let index = 0; index < characters.length && lines.length < maxLines; index += maxLength) {
    lines.push(characters.slice(index, index + maxLength).join(""));
  }
  if (characters.length > maxLength * maxLines && lines.length > 0) {
    lines[lines.length - 1] = `${lines[lines.length - 1].slice(0, -1)}...`;
  }
  return lines;
}

function pointsToPath(points: Array<{ x: number; y: number }>) {
  return orthogonalizePoints(points)
    .map((point, index) => `${index === 0 ? "M" : "L"} ${round(point.x)} ${round(point.y)}`)
    .join(" ");
}

function segmentMidpoint(points: Array<{ x: number; y: number }>) {
  const first = points[0];
  const last = points[points.length - 1] ?? first;
  return { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 };
}

function orthogonalizePoints(points: Array<{ x: number; y: number }>) {
  const compacted = compactPoints(points);
  if (compacted.length < 2) return compacted;

  const orthogonal = [compacted[0]];
  for (let index = 1; index < compacted.length; index += 1) {
    const previous = orthogonal[orthogonal.length - 1];
    const current = compacted[index];
    if (previous.x !== current.x && previous.y !== current.y) {
      const midX = (previous.x + current.x) / 2;
      orthogonal.push({ x: midX, y: previous.y }, { x: midX, y: current.y });
    }
    orthogonal.push(current);
  }

  return compactCollinearPoints(compactPoints(orthogonal));
}

function compactPoints(points: Array<{ x: number; y: number }>) {
  return points.filter((point, index) => {
    const previous = points[index - 1];
    return !previous || previous.x !== point.x || previous.y !== point.y;
  });
}

function compactCollinearPoints(points: Array<{ x: number; y: number }>) {
  return points.filter((point, index) => {
    const previous = points[index - 1];
    const next = points[index + 1];
    if (!previous || !next) return true;
    const isVertical = previous.x === point.x && point.x === next.x;
    const isHorizontal = previous.y === point.y && point.y === next.y;
    return !isVertical && !isHorizontal;
  });
}

function edgeColor(edgeType: FlowEdgeData["edge"]["edge_type"]) {
  if (edgeType === "rollback") return "#d94841";
  if (edgeType === "exception") return "#b26a00";
  if (edgeType === "escalation") return "#6f4bb2";
  return "#2f6f8f";
}

function fileSafeName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "_").trim() || "flowchart";
}

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}

function fontFamily() {
  return "Inter, Yu Gothic UI, Hiragino Sans, Meiryo, sans-serif";
}
