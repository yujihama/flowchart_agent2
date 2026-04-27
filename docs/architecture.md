# Architecture

## Overview

Flow Canon renders canonical business-flow JSON as a React Flow swimlane diagram.
The app now uses a single rule-based layout engine.

## Main Modules

- Canonical JSON parsing and validation live in the domain and validation modules.
- `build-swimlane-layout.ts` converts lanes, nodes, and edges into React Flow nodes and routed edges.
- `flow-reactflow-types.ts` defines the React Flow data payloads shared by nodes and edges.
- `FlowCanvas.tsx` renders the rule-based layout and detail panel.
- Custom nodes and routed edges live under `src/ui/nodes` and `src/ui/edges`.

## Layout

The rule-based layout treats the canvas as a grid of lanes and rows.
Each lane-row area can contain at most one node. Edges are routed as orthogonal
polylines with collision-reduction rules for horizontal and vertical segments.

See `docs/rule-based-routing.md` for the routing rules.

## UI

The canvas always uses the rule-based swimlane layout. The previous alternate
layout mode has been removed to keep the product behavior predictable.
