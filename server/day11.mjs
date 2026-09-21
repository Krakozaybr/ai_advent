import { estimateMessagesTokens } from "./token-counter.mjs";

const MEMORY_TOOL_INSTRUCTION = `У тебя есть MCP-инструмент memory_save.
Если пользователь явно просит что-то запомнить или сообщает факт, полезный в следующих ответах, вызови memory_save до ответа.
Выбирай shortTerm для временного контекста, working для текущей задачи, longTerm для устойчивых предпочтений пользователя.
Не сохраняй догадки и сведения, которых пользователь не сообщал.`;
const MAX_TOOL_ROUNDS = 4;

function formatItems(title, items) {
  if (items.length === 0) {
    return null;
  }
  return {
    role: "system",
    content: `${title}:\n${items.map((item) => `- ${item.key}: ${item.value}`).join("\n")}`,
  };
}

function buildMemoryMessages({ layers, messages }) {
  return [
    formatItems("Краткосрочные записи", layers.shortTerm),
    formatItems("Рабочая память текущей задачи", layers.working),
    formatItems("Долговременная память пользователя", layers.longTerm),
    ...messages.map(({ role, content }) => ({ role, content })),
  ].filter(Boolean);
}

function parseToolArguments(value) {
  if (value && typeof value === "object") return value;
  return JSON.parse(value || "{}");
}

function sumUsage(calls) {
  const result = {};
  for (const call of calls) {
    for (const [key, value] of Object.entries(call.usage || {})) {
      if (typeof value === "number") result[key] = (result[key] || 0) + value;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

function combineCalls(calls, toolLog) {
  const finalCall = calls.at(-1);
  const costs = calls.map((call) => call.cost).filter((cost) => typeof cost === "number");
  return {
    answer: finalCall.answer,
    model: finalCall.model,
    usage: sumUsage(calls),
    cost: costs.length > 0 ? costs.reduce((sum, cost) => sum + cost, 0) : null,
    finishReason: finalCall.finishReason,
    httpRequest: calls[0].httpRequest,
    httpRequests: calls.map((call) => call.httpRequest),
    latencyMs: calls.reduce((sum, call) => sum + (call.latencyMs || 0), 0),
    mcpToolCalls: toolLog,
  };
}

export class MemoryLayerAgent {
  constructor({ apiKey, maxTokens, memoryState, memoryTools, model, requestLlm, systemPrompt, temperature }) {
    this.apiKey = apiKey;
    this.maxTokens = maxTokens;
    this.memoryState = memoryState;
    this.memoryTools = memoryTools;
    this.model = model;
    this.requestLlm = requestLlm;
    this.systemPrompt = systemPrompt;
    this.temperature = temperature;
  }

  async request(messages, options = {}) {
    return this.requestLlm({
      apiKey: this.apiKey,
      maxTokens: this.maxTokens,
      messages: [...messages],
      model: this.model,
      temperature: this.temperature,
      ...options,
    });
  }

  async requestWithMemoryTools(initialMessages) {
    if (!this.memoryTools) {
      return this.request(initialMessages);
    }

    const tools = await this.memoryTools.getOpenRouterTools(["memory_save"]);
    const messages = [...initialMessages];
    const calls = [];
    const toolLog = [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const call = await this.request(messages, {
        parallelToolCalls: false,
        toolChoice: "auto",
        tools,
      });
      calls.push(call);
      if (!call.toolCalls?.length) {
        return combineCalls(calls, toolLog);
      }

      messages.push({
        role: "assistant",
        content: call.answer || null,
        tool_calls: call.toolCalls,
      });
      for (const toolCall of call.toolCalls) {
        let argumentsValue = {};
        let toolResult;
        try {
          argumentsValue = parseToolArguments(toolCall.function?.arguments);
          toolResult = await this.memoryTools.callTool(toolCall.function?.name, argumentsValue);
        } catch (error) {
          toolResult = {
            isError: true,
            text: error.message,
            structuredContent: { ok: false, error: error.message },
          };
        }
        toolLog.push({
          id: toolCall.id,
          name: toolCall.function?.name,
          arguments: argumentsValue,
          result: toolResult.structuredContent,
          isError: toolResult.isError,
        });
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolCall.function?.name,
          content: toolResult.text || JSON.stringify(toolResult.structuredContent),
        });
      }
    }

    throw new Error(`Агент превысил лимит MCP-вызовов: ${MAX_TOOL_ROUNDS}.`);
  }

  async compare(userMessage) {
    const base = [{ role: "system", content: this.systemPrompt }];
    const withoutMemoryMessages = [...base, { role: "user", content: userMessage }];
    const withMemoryMessages = [
      ...base,
      ...(this.memoryTools ? [{ role: "system", content: MEMORY_TOOL_INSTRUCTION }] : []),
      ...buildMemoryMessages(this.memoryState),
      { role: "user", content: userMessage },
    ];

    const [withoutMemory, withMemory] = await Promise.all([
      this.request(withoutMemoryMessages),
      this.requestWithMemoryTools(withMemoryMessages),
    ]);

    return {
      responses: { withoutMemory, withMemory },
      mcp: {
        server: "ai-advent-memory",
        transport: "stdio",
        toolCalls: withMemory.mcpToolCalls || [],
      },
      context: {
        withoutMemoryMessages: withoutMemoryMessages.length,
        withMemoryMessages: withMemoryMessages.length,
        shortTermMessages: this.memoryState.messages.length,
        layerItems: Object.fromEntries(
          Object.entries(this.memoryState.layers).map(([layer, items]) => [layer, items.length]),
        ),
      },
      tokenCounts: {
        estimatedWithoutMemory: estimateMessagesTokens(withoutMemoryMessages),
        estimatedWithMemory: estimateMessagesTokens(withMemoryMessages),
        actualWithoutMemory: withoutMemory.usage?.prompt_tokens ?? null,
        actualWithMemory: withMemory.usage?.prompt_tokens ?? null,
      },
    };
  }
}
