import { BaseEdge, BezierEdge, EdgeLabelRenderer } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";
import type { ElkEdgeSection, ElkPoint } from "elkjs/lib/elk.bundled.js";
import type { FlowEdge } from "../layout/elk";

function routePoints({ startPoint, bendPoints = [], endPoint }: ElkEdgeSection) {
  return [startPoint, ...bendPoints, endPoint].filter((point, index, points) => {
    const previous = points[index - 1];
    return !previous || point.x !== previous.x || point.y !== previous.y;
  });
}

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

function midpoint(start: ElkPoint, end: ElkPoint) {
  return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
}

function labelPosition(routes: ElkPoint[][], labelWidth: number) {
  const [first, next = first] = routes[0];
  let best = midpoint(first, next);
  let longest = 0;

  for (const points of routes) {
    for (let index = 1; index < points.length; index++) {
      const start = points[index - 1];
      const end = points[index];
      if (Math.abs(start.y - end.y) > 0.001) continue;

      // Skip short connector stubs where the label would cover the source or its other calls.
      const length = Math.abs(end.x - start.x);
      if (length >= labelWidth) return midpoint(start, end);
      if (length > longest) {
        longest = length;
        best = midpoint(start, end);
      }
    }
  }

  return best;
}

export function RoutedEdge(props: EdgeProps<FlowEdge>) {
  const { data, label, markerEnd, style, interactionWidth } = props;
  const sections = data?.sections;
  if (!sections?.length) return <BezierEdge {...props} />;

  const routes = sections.map(routePoints);
  const labelPoint = label ? labelPosition(routes, data.labelWidth) : null;
  return (
    <>
      {sections.map((section, index) => (
        <BaseEdge
          key={section.id}
          path={roundedPath(routes[index])}
          markerEnd={section.outgoingSections?.length ? undefined : markerEnd}
          interactionWidth={interactionWidth}
          style={style}
        />
      ))}
      {labelPoint && (
        <EdgeLabelRenderer>
          <span
            className="flow-edge-label"
            style={{ transform: `translate(-50%, -50%) translate(${labelPoint.x}px, ${labelPoint.y}px)` }}
          >
            {label}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
