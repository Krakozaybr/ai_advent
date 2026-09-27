#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

function openScope(readOnly = false) {
  const boardPath = process.env.AI_ADVENT_V3_BOARD_DB;
  const laneId = process.env.AI_ADVENT_V3_LANE_ID;
  const schedulePath = process.env.AI_ADVENT_V3_SCHEDULES_DB;
  if (!boardPath || !laneId || !schedulePath) throw new Error("Trusted board, lane and schedule database scope is required.");
  const board = new DatabaseSync(boardPath, { readOnly: true });
  const lane = board.prepare("SELECT board_id FROM lanes WHERE id=?").get(laneId);
  board.close();
  if (!lane) throw new Error("Trusted lane no longer exists.");
  const db = new DatabaseSync(schedulePath, { readOnly });
  db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
  return { db, boardId: lane.board_id };
}

const server = new McpServer({ name: "ai-advent-board-schedules", version: "1.0.0" });
const result = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
const scheduleId = z.string().min(1).max(80).describe("ID расписания на текущей доске");

server.registerTool("schedules_list", {
  title: "Расписания доски",
  description: "Показывает расписания и последние запуски только текущей доски.",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async () => {
  const { db, boardId } = openScope(true);
  try {
    const schedules = db.prepare("SELECT id,title,repeat_every_ms AS repeatEveryMs,next_run_at AS nextRunAt,status FROM schedules WHERE board_id=? ORDER BY next_run_at,id").all(boardId);
    const runs = db.prepare("SELECT id,schedule_id AS scheduleId,scheduled_for AS scheduledFor,status,missed_count AS missedCount,result_json AS result,error FROM schedule_runs WHERE board_id=? ORDER BY started_at DESC LIMIT 30").all(boardId);
    return result({ schedules, runs: runs.map((run) => ({ ...run, result: run.result ? JSON.parse(run.result) : null })) });
  } finally { db.close(); }
});

server.registerTool("schedule_create", {
  title: "Создать расписание",
  description: "Создаёт локальный запуск безопасной read-only агрегации демо-метрик. Изменение проходит через подтверждение MCP текущей ленты.",
  inputSchema: {
    title: z.string().trim().min(1).max(120).describe("Название расписания"),
    delayMs: z.number().int().min(250).max(86_400_000).describe("Задержка первого запуска в миллисекундах"),
    repeatEveryMs: z.number().int().min(250).max(86_400_000).optional().describe("Период повтора в миллисекундах; пропусти для одноразового запуска"),
    reason: z.string().trim().min(1).max(300).describe("Зачем нужно расписание"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ title, delayMs, repeatEveryMs, reason }) => {
  const { db, boardId } = openScope();
  try {
    const now = Date.now();
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO schedules(id,board_id,title,repeat_every_ms,next_run_at,status,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?)")
      .run(id,boardId,title.trim(),repeatEveryMs ?? null,now+delayMs,now,now);
    return result({ id, boardId, title: title.trim(), repeatEveryMs: repeatEveryMs ?? null, nextRunAt: now+delayMs, status: "active", reason });
  } finally { db.close(); }
});

server.registerTool("schedule_pause", {
  title: "Приостановить расписание",
  description: "Приостанавливает или возобновляет расписание текущей доски. Изменение проходит через подтверждение MCP текущей ленты.",
  inputSchema: { scheduleId, paused: z.boolean(), reason: z.string().trim().min(1).max(300) },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ scheduleId: id, paused, reason }) => {
  const { db, boardId } = openScope();
  try {
    const status = paused ? "paused" : "active";
    const update = db.prepare("UPDATE schedules SET status=?,updated_at=? WHERE id=? AND board_id=? AND status IN ('active','paused')").run(status,Date.now(),id,boardId);
    if (Number(update.changes) !== 1) throw new Error("Расписание не найдено на этой доске.");
    return result({ scheduleId: id, boardId, status, reason });
  } finally { db.close(); }
});

await server.connect(new StdioServerTransport());
