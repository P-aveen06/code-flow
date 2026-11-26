import { BaseEdge, BezierEdge, EdgeLabelRenderer } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";
import type { ElkPoint } from "elkjs/lib/elk.bundled.js";
import { routePoints } from "../layout/edgeLabels";
import type { FlowEdge } from "../layout/elk";

function distance(a: ElkPoint, b: ElkPoint) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function toward(start: ElkPoint, end: ElkPoint, offset: number) {
  const fraction = offset / distance(start, end);
  return `${start.x + (end.x - start.x) * fraction} ${start.y + (end.y - start.y) * fraction}`;
}

function roundedPath(points: ElkPoint[]) {
  const [start] = points;
  const end = points[points.length - 1];
  let path = `M ${start.x} ${start.y}`;

  for (let index = 1; index < points.length - 1; index++) {
    const [previous, corner, next] = points.slice(index - 1, index + 2);
    const radius = Math.min(8, distance(corner, previous) / 2, distance(corner, next) / 2);
    path += ` L ${toward(corner, previous, radius)} Q ${corner.x} ${corner.y} ${toward(corner, next, radius)}`;
  }

  return `${path} L ${end.x} ${end.y}`;
}

export function RoutedEdge(props: EdgeProps<FlowEdge>) {
  const { data, label, markerEnd, style, interactionWidth } = props;
  const sections = data?.sections;
  const placement = data?.labelPlacement;
  const center = placement?.center;
  return (
    <>
      {sections?.length ? sections.map((section) => (
        <BaseEdge
          key={section.id}
          path={roundedPath(routePoints(section))}
          markerEnd={section.outgoingSections?.length ? undefined : markerEnd}
          interactionWidth={interactionWidth}
          style={style}
        />
      )) : <BezierEdge {...props} label={undefined} />}
      {placement && center && (placement.anchor.x !== center.x || placement.anchor.y !== center.y) && (
        <line
          className="flow-edge-label-leader"
          x1={placement.anchor.x} y1={placement.anchor.y} x2={center.x} y2={center.y}
          style={{ opacity: style?.opacity, stroke: style?.stroke }}
        />
      )}
      {center && (
        <EdgeLabelRenderer>
          <span
            className="flow-edge-label"
            style={{
              transform: `translate(-50%, -50%) translate(${center.x}px, ${center.y}px)`,
              opacity: style?.opacity,
            }}
          >
            {label}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
