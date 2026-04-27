# Rule-based swimlane routing

## Overview

The rule layout treats the canvas as a grid of lanes and rows.
Each lane-row area can contain at most one node. Edges are routed with
orthogonal polylines so that they can use the empty margins around those areas.

## Routing Rules

- Normal flow uses `source bottom -> target top`.
- During row assignment, a normal-flow target is placed below every already placed normal-flow source, so lane conflict pushes do not leave downstream nodes visually above their predecessors.
- Same-row handoff between lanes uses the left or right side when the lanes between them are empty.
- Multiple outgoing edges from a decision node reserve one full row below the decision across all lanes, share one center-bottom trunk, and split at a junction in that reserved row.
- Decision branch labels are distributed within each branch direction so labels do not stack when several choices go left or right.
- Decision branch tracks in the same direction are ordered by target row, so upward branches use upper tracks and downward branches use lower tracks.
- When a vertical path would pass through occupied lane-row areas, the edge moves to the lane side gutter, travels vertically there, and returns near the target.
- Rollback and other side-to-side flows use lane side gutters and row-bottom corridors instead of crossing node centers.
- Lane side gutters reserve vertical intervals per track. When several edges use the same side gutter over overlapping vertical ranges, later edges move to the next gutter track.
- After route generation, middle horizontal segments are grouped by overlapping x-ranges on the same y-coordinate. Overlapping non-decision segments are assigned parallel y-tracks while source and target endpoints stay fixed.
- Middle vertical segments are also grouped by overlapping y-ranges on the same or very close x-coordinate. Overlapping segments are assigned parallel x-tracks while source and target endpoints stay fixed.
- Edge labels are placed at the midpoint of the longest routed segment.

## Current Limits

- Gutter track reservation is local to lane side gutters; it does not perform full graph-wide segment crossing minimization.
- Horizontal overlap resolution skips only the first shared horizontal segment of a decision branch, so the branch row can intentionally share a line while later target-corridor segments can still be distributed.
- Vertical overlap resolution applies to middle routed segments, including decision branch tracks. Source/target-adjacent segments stay fixed to preserve node connections.
- The rule layout is the only supported layout mode.
