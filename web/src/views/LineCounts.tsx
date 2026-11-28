import { formatLineCounts } from "./styles";

export function LineCounts({ added, removed }: {
  added: number | null;
  removed: number | null;
}) {
  const counts = formatLineCounts(added, removed);
  if (!counts.added && !counts.removed) return null;
  return (
    <span className="line-counts">
      {counts.added && <span className="line-counts__added">{counts.added}</span>}
      {counts.removed && <span className="line-counts__removed">{counts.removed}</span>}
    </span>
  );
}
