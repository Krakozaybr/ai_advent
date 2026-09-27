export function chooseBoardId(savedId, boards) {
  if (savedId && boards.some((board) => board.id === savedId)) return savedId;
  return boards[0]?.id ?? null;
}
