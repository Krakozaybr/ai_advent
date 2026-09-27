#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

function openScope(readOnly = false) {
  const boardPath = process.env.AI_ADVENT_V3_BOARD_DB;
  const laneId = process.env.AI_ADVENT_V3_LANE_ID;
  const taskPath = process.env.AI_ADVENT_V3_TASKS_DB;
  if (!boardPath || !laneId || !taskPath) throw new Error("Trusted board, lane and task database scope is required.");
  const board = new DatabaseSync(boardPath, { readOnly: true });
  const lane = board.prepare("SELECT board_id FROM lanes WHERE id=?").get(laneId);
  board.close();
  if (!lane) throw new Error("Trusted lane no longer exists.");
  const db = new DatabaseSync(taskPath, { readOnly });
  db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
  return { db, boardId: lane.board_id };
}

const server = new McpServer({ name: "ai-advent-board-tasks", version: "1.0.0" });
const result = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
const taskId = z.string().min(1).max(80).describe("ID задачи текущей доски");

server.registerTool("tasks_list", {
  title: "Список задач доски",
  description: "Показывает задачи и сохранённое состояние только текущей доски.",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async () => {
  const { db, boardId } = openScope(true);
  try {
    const tasks = db.prepare("SELECT id,title,description,status,stage,plan,plan_approved AS planApproved,current_step AS currentStep,expected_action AS expectedAction,paused,updated_at AS updatedAt FROM tasks WHERE board_id=? ORDER BY updated_at DESC,id").all(boardId);
    return result({ tasks: tasks.map((task) => ({ ...task, planApproved: Boolean(task.planApproved), paused: Boolean(task.paused) })) });
  } finally { db.close(); }
});

server.registerTool("tasks_read", {
  title: "Прочитать задачу",
  description: "Читает задачу, этап, шаг, ожидание и комментарии по ID в текущей доске.",
  inputSchema: { taskId },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ taskId: id }) => {
  const { db, boardId } = openScope(true);
  try {
    const task = db.prepare("SELECT id,title,description,status,stage,plan,plan_approved AS planApproved,current_step AS currentStep,expected_action AS expectedAction,paused,created_at AS createdAt,updated_at AS updatedAt FROM tasks WHERE board_id=? AND id=?").get(boardId,id);
    if (!task) throw new Error("Задача не найдена на этой доске.");
    task.planApproved = Boolean(task.planApproved); task.paused = Boolean(task.paused);
    task.comments = db.prepare("SELECT content,created_at AS createdAt FROM task_comments WHERE board_id=? AND task_id=? ORDER BY created_at,id").all(boardId,id);
    return result(task);
  } finally { db.close(); }
});

server.registerTool("tasks_propose_update", {
  title: "Предложить изменение задачи",
  description: "Предлагает изменить поля, добавить комментарий или перейти на следующий этап. Изменяющий вызов проходит через подтверждение MCP текущей ленты. Этапы и утверждение плана проверяет база данных.",
  inputSchema: {
    taskId,
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(10000).optional(),
    plan: z.string().max(10000).optional(),
    approvePlan: z.boolean().optional().describe("Явное утверждение уже сохранённого непустого плана"),
    stage: z.enum(["planning", "execution", "validation", "done"]).optional(),
    currentStep: z.string().max(1000).optional(),
    expectedAction: z.string().max(1000).optional(),
    paused: z.boolean().optional(),
    comment: z.string().trim().min(1).max(4000).optional(),
    reason: z.string().trim().min(1).max(300).describe("Зачем нужно изменение"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ taskId: id, title, description, plan, approvePlan, stage, currentStep, expectedAction, paused, comment, reason }) => {
  const { db, boardId } = openScope();
  try {
    db.exec("BEGIN IMMEDIATE");
    const exists = db.prepare("SELECT 1 FROM tasks WHERE board_id=? AND id=?").get(boardId,id);
    if (!exists) throw new Error("Задача не найдена на этой доске.");
    const nextStatus = stage === "done" ? "done" : null;
    db.prepare("UPDATE tasks SET title=COALESCE(?,title),description=COALESCE(?,description),plan=COALESCE(?,plan),plan_approved=COALESCE(?,plan_approved),stage=COALESCE(?,stage),current_step=COALESCE(?,current_step),expected_action=COALESCE(?,expected_action),paused=COALESCE(?,paused),status=COALESCE(?,status),updated_at=? WHERE board_id=? AND id=?")
      .run(title ?? null,description ?? null,plan ?? null,approvePlan == null ? null : Number(approvePlan),stage ?? null,currentStep ?? null,expectedAction ?? null,paused == null ? null : Number(paused),nextStatus,new Date().toISOString(),boardId,id);
    if (comment) db.prepare("INSERT INTO task_comments(id,board_id,task_id,content,created_at) VALUES(?,?,?,?,?)").run(crypto.randomUUID(),boardId,id,comment,new Date().toISOString());
    db.exec("COMMIT");
    const updated = db.prepare("SELECT id,title,description,status,stage,plan,plan_approved AS planApproved,current_step AS currentStep,expected_action AS expectedAction,paused,updated_at AS updatedAt FROM tasks WHERE board_id=? AND id=?").get(boardId,id);
    updated.planApproved = Boolean(updated.planApproved); updated.paused = Boolean(updated.paused);
    return result({ task: updated, reason });
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally { db.close(); }
});

await server.connect(new StdioServerTransport());
