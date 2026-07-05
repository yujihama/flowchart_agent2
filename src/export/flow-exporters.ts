import type { Edge, Node } from "@xyflow/react";
import type { FlowModel } from "../domain/flow-model";
import type { FlowEdgeData, FlowNodeData, LaneNodeData, PhaseBandData } from "../layout/flow-reactflow-types";
import {
  LANE_HEADER_HEIGHT,
  LANE_PALETTE,
  LANE_WIDTH,
  NODE_HEIGHT_BY_TYPE,
  NODE_WIDTH_BY_TYPE,
} from "../layout/swimlane-constants";

type ExportNode = Node<FlowNodeData | LaneNodeData | PhaseBandData>;
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
  const phaseBandNodes = nodes.filter((node): node is Node<PhaseBandData> => node.data.kind === "phaseBand");
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
    ...phaseBandNodes.map(renderPhaseBand),
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
    `<rect x="${x}" y="${y}" width="${width}" height="${LANE_HEADER_HEIGHT}" fill="${color.header}" stroke="#c8d4dc"/>`,
    `<rect x="${x}" y="${y}" width="5" height="${LANE_HEADER_HEIGHT}" fill="${color.accent}"/>`,
    `<rect x="${x + 16}" y="${y + 19}" width="40" height="24" rx="12" fill="${color.chip}"/>`,
    `<text x="${x + 36}" y="${y + 35}" text-anchor="middle" dominant-baseline="central" fill="${color.accent}" font-family="${fontFamily()}" font-size="10" font-weight="800">${escapeXml(lane.id)}</text>`,
    `<text x="${x + 64}" y="${y + 26}" fill="#22313f" font-family="${fontFamily()}" font-size="14" font-weight="800">${escapeXml(lane.name)}</text>`,
    `<text x="${x + 64}" y="${y + 45}" fill="#657784" font-family="${fontFamily()}" font-size="10" font-weight="700">${escapeXml(lane.type)}</text>`,
  ].join("");
}

function renderPhaseBand(node: Node<PhaseBandData>) {
  const { phase, bandIndex, width, height, showBoundary } = node.data;
  const x = node.position.x;
  const y = node.position.y;
  const chipWidth = Math.min(380, Math.max(60, estimateTextWidth(phase.name, 11) + 26));

  return [
    bandIndex % 2 === 1 ? `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#1f3d54" fill-opacity="0.045"/>` : "",
    showBoundary
      ? `<line x1="${x}" y1="${y}" x2="${x + width}" y2="${y}" stroke="#46647a" stroke-opacity="0.5" stroke-width="2" stroke-dasharray="7 6"/>`
      : "",
    `<rect x="${x + 10}" y="${y + 9}" width="${chipWidth}" height="24" rx="12" fill="#ffffff" fill-opacity="0.92" stroke="#b9c9d4"/>`,
    `<text x="${x + 10 + chipWidth / 2}" y="${y + 21}" text-anchor="middle" dominant-baseline="central" fill="#3c5162" font-family="${fontFamily()}" font-size="11" font-weight="800">${escapeXml(phase.name)}</text>`,
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
    const width =
      node.data.kind === "flow" ? NODE_WIDTH_BY_TYPE[node.data.node.type] : (node.data.width ?? LANE_WIDTH);
    const height = node.data.kind === "flow" ? NODE_HEIGHT_BY_TYPE[node.data.node.type] : node.data.height;
    return [
      { x: node.position.x, y: node.position.y },
      { x: node.position.x + width, y: node.position.y + height },
    ];
  });
  const edgeBounds = edges.flatMap((edge) => edge.data?.routePath ?? []);
  let minX = 0;
  let minY = 0;
  let maxX = 900;
  let maxY = 600;
  for (const point of [...nodeBounds, ...edgeBounds]) {
    if (Number.isFinite(point.x)) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
    }
    if (Number.isFinite(point.y)) {
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }
  }
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

const PNG_EXPORT_SCALE = 2;
const PNG_EXPORT_MAX_PIXELS = 64_000_000;

function svgToPngBlob(svg: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    const image = new Image();
    image.onload = () => {
      const width = Math.max(image.naturalWidth, 1);
      const height = Math.max(image.naturalHeight, 1);
      const scale = Math.min(PNG_EXPORT_SCALE, Math.sqrt(PNG_EXPORT_MAX_PIXELS / (width * height)));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        URL.revokeObjectURL(url);
        reject(new Error("Canvas context could not be created."));
        return;
      }
      context.fillStyle = "#eef2f5";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
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
  const phaseBandNodes = nodes.filter((node): node is Node<PhaseBandData> => node.data.kind === "phaseBand");
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
    items.push(
      shapeXml(nextId(), `lane-header-${lane.id}`, "rect", x, y, w, diagramSize(LANE_HEADER_HEIGHT), color.header, "#c8d4dc"),
    );
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

  phaseBandNodes.forEach((node) => {
    const { phase, bandIndex, width, height, showBoundary } = node.data;
    const x = diagramX(node.position.x);
    const y = diagramY(node.position.y);
    if (bandIndex % 2 === 1) {
      items.push(
        shapeXml(nextId(), `phase-band-${phase.id}`, "rect", x, y, diagramSize(width), diagramSize(height), "#1f3d54", "#1f3d54", "", {
          fillAlphaPercent: 4.5,
          noStroke: true,
        }),
      );
    }
    if (showBoundary) {
      items.push(
        connectorXml(
          nextId(),
          `phase-boundary-${phase.id}`,
          [node.position, { x: node.position.x + width, y: node.position.y }],
          "#46647a",
          true,
          12700,
          false,
        ),
      );
    }
    const chipWidth = Math.min(380, Math.max(60, estimateTextWidth(phase.name, 9) + 24));
    items.push(
      shapeXml(
        nextId(),
        `phase-label-${phase.id}`,
        "roundRect",
        x + diagramSize(10),
        y + diagramSize(9),
        diagramSize(chipWidth),
        diagramSize(24),
        "#ffffff",
        "#b9c9d4",
        phase.name,
        { fontSize: 9, bold: true, fontColor: "#3c5162" },
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
      items.push(shapeXml(shapeId, flowNode.id, "diamond", x, y, w, h, "#fff3cf", "#c99d34", flowNode.label, {
        fontSize: 10,
        bold: true,
        fontColor: "#43340e",
      }));
      return;
    }

    if (flowNode.type === "start" || flowNode.type === "end") {
      items.push(
        shapeXml(
          shapeId,
          flowNode.id,
          "roundRect",
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

    items.push(shapeXml(shapeId, flowNode.id, "roundRect", x, y, w, h, "#ffffff", "#bccbd4", flowNode.label, {
      fontSize: 10,
      bold: true,
      fontColor: "#17212b",
    }));
  });

  edges.forEach((edge) => {
    const data = edge.data;
    if (!data?.routePath?.length) return;
    const edgeType = data.edge.edge_type;
    const color = edgeColor(edgeType);
    const points = orthogonalizePoints(data.routePath);
    items.push(
      connectorXml(
        nextId(),
        `edge-${edge.id}`,
        points,
        color,
        edgeType === "rollback",
        edgeType === "rollback" || edgeType === "exception" ? 24765 : 19050,
      ),
    );
    const label = edge.label ? String(edge.label) : "";
    if (label) {
      const labelPoint = data.labelPoint ?? segmentMidpoint(points);
      const labelWidth = Math.min(200, Math.max(36, estimateTextWidth(label, 9) + 14));
      items.push(
        shapeXml(
          nextId(),
          `edge-label-${edge.id}`,
          "roundRect",
          diagramX(labelPoint.x) - diagramSize(labelWidth / 2),
          diagramY(labelPoint.y) - diagramSize(11),
          diagramSize(labelWidth),
          diagramSize(22),
          "#ffffff",
          "#ffffff",
          label,
          { fontSize: 9, bold: true, fontColor: "#22313f" },
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
  fillAlphaPercent?: number;
  noStroke?: boolean;
};

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
  const alpha =
    options.fillAlphaPercent !== undefined ? `<a:alpha val="${Math.round(options.fillAlphaPercent * 1000)}"/>` : "";
  const line = options.noStroke
    ? "<a:ln><a:noFill/></a:ln>"
    : `<a:ln w="9525"><a:solidFill><a:srgbClr val="${hex(stroke)}"/></a:solidFill></a:ln>`;
  return [
    `${twoCellAnchorOpen(x, y, width, height)}`,
    `<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="${id}" name="${escapeXml(name)}"/><xdr:cNvSpPr/></xdr:nvSpPr>`,
    `<xdr:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${Math.max(width, 1)}" cy="${Math.max(height, 1)}"/></a:xfrm><a:prstGeom prst="${preset}"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${hex(fill)}"${alpha ? `>${alpha}</a:srgbClr>` : "/>"}</a:solidFill>${line}</xdr:spPr>`,
    textBodyXml(text, options),
    "</xdr:sp><xdr:clientData/></xdr:twoCellAnchor>",
  ].join("");
}

function connectorXml(
  id: number,
  name: string,
  routePoints: Array<{ x: number; y: number }>,
  color: string,
  dashed: boolean,
  lineWidthEmu = 19050,
  arrowEnd = true,
) {
  const points = routePoints.map((point) => ({ x: diagramX(point.x), y: diagramY(point.y) }));
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  const relativePoints = points.map((point) => ({
    x: Math.max(point.x - minX, 0),
    y: Math.max(point.y - minY, 0),
  }));
  const [firstPoint, ...linePoints] = relativePoints;

  return [
    `${twoCellAnchorOpen(minX, minY, width, height)}`,
    `<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="${id}" name="${escapeXml(name)}"/><xdr:cNvSpPr/></xdr:nvSpPr>`,
    `<xdr:spPr><a:xfrm><a:off x="${minX}" y="${minY}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="${width}" b="${height}"/><a:pathLst><a:path w="${width}" h="${height}"><a:moveTo><a:pt x="${firstPoint?.x ?? 0}" y="${firstPoint?.y ?? 0}"/></a:moveTo>${linePoints.map((point) => `<a:lnTo><a:pt x="${point.x}" y="${point.y}"/></a:lnTo>`).join("")}</a:path></a:pathLst></a:custGeom><a:noFill/><a:ln w="${lineWidthEmu}"><a:solidFill><a:srgbClr val="${hex(color)}"/></a:solidFill>${dashed ? '<a:prstDash val="dash"/>' : ""}${arrowEnd ? '<a:tailEnd type="arrow"/>' : ""}</a:ln></xdr:spPr>`,
    "</xdr:sp><xdr:clientData/></xdr:twoCellAnchor>",
  ].join("");
}

function estimateTextWidth(text: string, fontSizePt: number) {
  const pxPerPoint = 4 / 3;
  let units = 0;
  for (const char of text) {
    // Full-width characters (CJK, kana, full-width forms) take ~1em, others ~0.55em.
    units += /[ᄀ-￦]/.test(char) ? 1 : 0.55;
  }
  return units * fontSizePt * pxPerPoint;
}

const ANCHOR_COL_WIDTH_EMU = 72 * 9525;
const ANCHOR_ROW_HEIGHT_EMU = 24 * 9525;

function twoCellAnchorOpen(x: number, y: number, width: number, height: number) {
  const from = cellAnchorPoint(x, y);
  const to = cellAnchorPoint(x + Math.max(width, 1), y + Math.max(height, 1));
  return `<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${from.col}</xdr:col><xdr:colOff>${from.colOff}</xdr:colOff><xdr:row>${from.row}</xdr:row><xdr:rowOff>${from.rowOff}</xdr:rowOff></xdr:from><xdr:to><xdr:col>${to.col}</xdr:col><xdr:colOff>${to.colOff}</xdr:colOff><xdr:row>${to.row}</xdr:row><xdr:rowOff>${to.rowOff}</xdr:rowOff></xdr:to>`;
}

function cellAnchorPoint(x: number, y: number) {
  return {
    col: Math.max(0, Math.floor(x / ANCHOR_COL_WIDTH_EMU)),
    colOff: Math.max(0, Math.round(x % ANCHOR_COL_WIDTH_EMU)),
    row: Math.max(0, Math.floor(y / ANCHOR_ROW_HEIGHT_EMU)),
    rowOff: Math.max(0, Math.round(y % ANCHOR_ROW_HEIGHT_EMU)),
  };
}

function textBodyXml(text: string, options: ShapeOptions) {
  const fontSize = Math.round((options.fontSize ?? 10) * 100);
  const bold = options.bold ? ' b="1"' : "";
  const color = hex(options.fontColor ?? "#17212b");
  const paragraphs = text
    ? text.split("\n").map((line) => `<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="ja-JP" sz="${fontSize}"${bold}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:rPr><a:t>${escapeXml(line)}</a:t></a:r></a:p>`)
    : ["<a:p/>"];
  return `<xdr:txBody><a:bodyPr wrap="square" anchor="ctr" lIns="45720" tIns="22860" rIns="45720" bIns="22860"/><a:lstStyle/>${paragraphs.join("")}</xdr:txBody>`;
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

  const pane = sheet.drawingXml ? "" : '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>';

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    `<dimension ref="${refs}"/>`,
    `<sheetViews><sheetView workbookViewId="0"${sheet.drawingXml ? ' showGridLines="0"' : ""}>${pane}</sheetView></sheetViews>`,
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
