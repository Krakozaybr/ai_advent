export function importedBoardFromResponse(result, source) {
  const imported = result?.board;
  const board = imported?.board;
  const isId = (value) => typeof value === "string" && value.trim().length > 0;

  if (!isId(result?.boardId) || !isId(board?.id) || result.boardId !== board.id) {
    throw new Error(`${source}: API вернул отсутствующий или несовпадающий ID доски.`);
  }
  if (typeof board.title !== "string" || !Array.isArray(imported.lanes) || !Array.isArray(imported.agents)) {
    throw new Error(`${source}: API вернул доску с неверной структурой.`);
  }
  if (imported.lanes.some((lane) => !isId(lane?.id) || typeof lane.title !== "string")
      || imported.agents.some((agent) => !isId(agent?.id) || typeof agent.name !== "string")) {
    throw new Error(`${source}: API вернул ленту или агента без обязательного ID/имени.`);
  }
  return imported;
}
