export type GraphViewportPoint = { x: number; y: number };
export type GraphViewportFit = { zoom: number; pan: { x: number; y: number } };

/// Compute a transform that makes a persisted absolute-position graph fully
/// visible in the current canvas. The points remain untouched; only the view
/// changes, so manual layouts survive different windows and computers.
export function computeGraphViewportFit(
  points: GraphViewportPoint[],
  width: number,
  height: number,
  nodeWidth: number,
  nodeHeight: number,
): GraphViewportFit | null {
  if (points.length === 0 || width <= 0 || height <= 0) return null;
  const framePad = 34;
  const minX = Math.min(...points.map((p) => p.x)) - framePad;
  const minY = Math.min(...points.map((p) => p.y)) - framePad - 20;
  const maxX = Math.max(...points.map((p) => p.x + nodeWidth)) + framePad;
  const maxY = Math.max(...points.map((p) => p.y + nodeHeight)) + framePad;
  const boundsWidth = Math.max(1, maxX - minX);
  const boundsHeight = Math.max(1, maxY - minY);
  const zoom = Math.max(0.25, Math.min(1, (width - 24) / boundsWidth, (height - 24) / boundsHeight));
  return {
    zoom,
    pan: {
      x: (width - boundsWidth * zoom) / 2 - minX * zoom,
      y: (height - boundsHeight * zoom) / 2 - minY * zoom,
    },
  };
}
