export function arrangeLanes(lanes, gap = 66) {
  const visible = lanes.filter((lane) => !lane.archived);
  const byId = new Map(visible.map((lane) => [lane.id, lane]));
  const linkedKinds = new Set(["branch", "subagent"]);
  const roots = visible.filter((lane) => !linkedKinds.has(lane.originKind) || !lane.originLaneId || !byId.has(lane.originLaneId))
    .sort((a, b) => a.x - b.x || visible.indexOf(b) - visible.indexOf(a));
  const ordered = [];
  const seen = new Set();
  function append(lane) {
    if (seen.has(lane.id)) return;
    seen.add(lane.id);
    ordered.push(lane);
    const children = visible.filter((item) => linkedKinds.has(item.originKind) && item.originLaneId === lane.id)
      .sort((a, b) => {
        if (a.originKind === "subagent" && b.originKind === "subagent") return (b.launchOrder ?? 0) - (a.launchOrder ?? 0);
        if (a.originKind === "subagent") return -1;
        if (b.originKind === "subagent") return 1;
        return visible.indexOf(a) - visible.indexOf(b);
      });
    for (const child of children) append(child);
  }
  for (const root of roots) append(root);
  for (const lane of visible) append(lane);

  let x = Math.max(160, roots[0]?.x ?? 160);
  return ordered.map((lane, index) => {
    if (index > 0) {
      const previous = ordered[index - 1];
      const compactSubagent = lane.originKind === "subagent" && (
        lane.originLaneId === previous.id ||
        (previous.originKind === "subagent" && previous.originLaneId === lane.originLaneId)
      );
      x += Math.max(560, previous.width) + (compactSubagent ? 0 : gap);
    }
    return { ...lane, x, width: Math.max(560, lane.width) };
  });
}
