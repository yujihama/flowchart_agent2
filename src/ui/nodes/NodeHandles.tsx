import { Handle, Position } from "@xyflow/react";

const HANDLE_SIDES = [
  { side: "top", position: Position.Top },
  { side: "right", position: Position.Right },
  { side: "bottom", position: Position.Bottom },
  { side: "left", position: Position.Left },
] as const;

const HANDLE_SLOTS = [0, 1, 2] as const;

export function NodeHandles() {
  return (
    <>
      {HANDLE_SIDES.flatMap(({ side, position }) =>
        HANDLE_SLOTS.flatMap((slot) => [
          <Handle
            className={`node-handle node-handle--${side} node-handle--slot-${slot}`}
            id={`target-${side}-${slot}`}
            key={`target-${side}-${slot}`}
            type="target"
            position={position}
          />,
          <Handle
            className={`node-handle node-handle--${side} node-handle--slot-${slot}`}
            id={`source-${side}-${slot}`}
            key={`source-${side}-${slot}`}
            type="source"
            position={position}
          />,
        ]),
      )}
    </>
  );
}
