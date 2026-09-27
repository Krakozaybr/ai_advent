import test from "node:test";
import assert from "node:assert/strict";
import { importedBoardFromResponse } from "../examples/ai-advent/bootstrap-response.mjs";

const validResponse = {
  boardId: "board-123",
  board: {
    board: { id: "board-123", title: "Демо" },
    lanes: [{ id: "lane-123", title: "Основная" }],
    agents: [{ id: "agent-123", name: "Планировщик" }],
  },
};

test("bootstrap unwraps the imported board and retains lanes and agents", () => {
  assert.deepEqual(importedBoardFromResponse(validResponse, "board-11.json"), validResponse.board);
});

test("bootstrap fails fast when the imported board ID is missing or inconsistent", () => {
  assert.throws(() => importedBoardFromResponse({ ...validResponse, boardId: undefined }, "board-11.json"), /ID доски/);
  assert.throws(() => importedBoardFromResponse({ ...validResponse, boardId: "other" }, "board-11.json"), /ID доски/);
  assert.throws(() => importedBoardFromResponse({ ...validResponse, board: { ...validResponse.board, board: {} } }, "board-11.json"), /ID доски/);
});

test("bootstrap fails fast when required imported structures are missing", () => {
  assert.throws(() => importedBoardFromResponse({ ...validResponse, board: { ...validResponse.board, lanes: null } }, "board-11.json"), /неверной структурой/);
  assert.throws(() => importedBoardFromResponse({ ...validResponse, board: { ...validResponse.board, lanes: [{ title: "Без ID" }] } }, "board-11.json"), /без обязательного ID/);
});
