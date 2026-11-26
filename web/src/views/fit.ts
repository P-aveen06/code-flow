export function chooseFitTarget(allBoundsZoom: number, minReadableZoom: number): "all" | "changed" {
  return allBoundsZoom >= minReadableZoom ? "all" : "changed";
}
