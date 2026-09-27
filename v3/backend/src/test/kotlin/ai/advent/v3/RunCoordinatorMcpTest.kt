package ai.advent.v3

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class RunCoordinatorMcpTest {
    @Test
    fun `selected lane calls MCP and returns result to model while another lane stays disabled`() = runBlocking {
        val temp = Files.createTempDirectory("v3-mcp-loop")
        val store = WorkspaceStore(temp.resolve("board.sqlite"))
        val boardId = store.boards().first().jsonObject["id"]!!.jsonPrimitive.content
        val selectedLane = createOpenRouterLane(store, boardId)
        val disabledLane = createOpenRouterLane(store, boardId)
        val root = Path.of(System.getProperty("user.dir")).toAbsolutePath().parent.parent
        val server = McpServerConfig("local-catalog", "Catalog", "", "node", listOf(root.resolve("examples/mcp/catalog-server.mjs").toString()), root.toString())
        store.saveMcpTools(selectedLane, listOf(McpSelection("local-catalog", "search_catalog")))
        val gateway = RecordingOpenRouter()
        val keyStore = OpenRouterKeyStore(temp.resolve("openrouter.key")).also { it.save("test-server-key-only") }
        val coordinator = RunCoordinator(store, NoopCodex(), gateway, keyStore, McpRegistry(listOf(server)))
        try {
            val selectedRun = coordinator.submit(selectedLane, "Найди заметку о безопасности")
            val disabledRun = coordinator.submit(disabledLane, "Обычный ответ без MCP")
            waitForTerminal(store, selectedRun)
            waitForTerminal(store, disabledRun)

            assertEquals(2, gateway.toolRoundCalls)
            assertTrue(gateway.messagesSeenByContinuation.single().last { it["role"]?.jsonPrimitive?.content == "tool" }["content"]!!.jsonPrimitive.content.contains("structuredContent"))
            assertTrue(gateway.standardStreamCalls >= 1)
            val selected = store.laneSnapshot(selectedLane)["messages"]!!.jsonArray
                .map { it.jsonObject }.last { it["role"]?.jsonPrimitive?.content == "assistant" }
            val details = selected["technicalDetails"]!!.jsonObject
            val calls = details["toolCalls"]!!.jsonArray
            assertEquals(1, calls.size)
            assertTrue(calls.single().jsonObject["ok"]!!.jsonPrimitive.content.toBoolean())
            assertTrue(calls.single().jsonObject.toString().contains("structuredContent"))
            val events = store.eventsAfter(selectedRun, 0).map { it.second["type"]!!.jsonPrimitive.content }
            assertTrue("tool.started" in events && "tool.completed" in events)
            val disabled = store.laneSnapshot(disabledLane)["messages"]!!.jsonArray.map { it.jsonObject }
                .last { it["role"]?.jsonPrimitive?.content == "assistant" }
            assertFalse(disabled["technicalDetails"]!!.jsonObject.containsKey("toolCalls"))
            assertFalse(keyStore.get() in store.board(boardId).toString())
        } finally {
            coordinator.close()
        }
    }

    @Test
    fun `invalid arguments and model requested unknown tool are rejected before MCP call`() = runBlocking {
        assertRejectedTool("mcp_tool_0", "{\"query\":3}", "must be string")
        assertRejectedTool("local-catalog__delete_everything", "{}", "неразрешённый")
    }

    private suspend fun assertRejectedTool(name: String, args: String, expectedError: String) {
        val temp = Files.createTempDirectory("v3-mcp-reject")
        val store = WorkspaceStore(temp.resolve("board.sqlite"))
        val boardId = store.boards().first().jsonObject["id"]!!.jsonPrimitive.content
        val lane = createOpenRouterLane(store, boardId)
        val root = Path.of(System.getProperty("user.dir")).toAbsolutePath().parent.parent
        val server = McpServerConfig("local-catalog", "Catalog", "", "node", listOf(root.resolve("examples/mcp/catalog-server.mjs").toString()), root.toString())
        store.saveMcpTools(lane, listOf(McpSelection("local-catalog", "search_catalog")))
        val gateway = RecordingOpenRouter(name, args)
        val coordinator = RunCoordinator(store, NoopCodex(), gateway,
            OpenRouterKeyStore(temp.resolve("openrouter.key")).also { it.save("test-server-key-only") }, McpRegistry(listOf(server)))
        try {
            val runId = coordinator.submit(lane, "Проверь инструмент")
            waitForTerminal(store, runId)
            val assistant = store.laneSnapshot(lane)["messages"]!!.jsonArray.map { it.jsonObject }
                .last { it["role"]?.jsonPrimitive?.content == "assistant" }
            val calls = assistant["technicalDetails"]!!.jsonObject["toolCalls"]!!.jsonArray
            assertEquals(1, calls.size)
            assertFalse(calls.single().jsonObject["ok"]!!.jsonPrimitive.content.toBoolean())
            assertTrue(calls.single().jsonObject["error"]!!.jsonPrimitive.content.contains(expectedError, ignoreCase = true),
                "Expected error containing '$expectedError', got ${calls.single().jsonObject["error"]}")
            val responseToModel = gateway.messagesSeenByContinuation.single().last { it["role"]?.jsonPrimitive?.content == "tool" }
            assertTrue(responseToModel["content"]!!.jsonPrimitive.content.contains("Tool error:"))
        } finally {
            coordinator.close()
        }
    }

    private fun createOpenRouterLane(store: WorkspaceStore, boardId: String): String {
        val board = store.createLane(boardId, "openrouter")
        val laneId = board["lanes"]!!.jsonArray.last().jsonObject["id"]!!.jsonPrimitive.content
        store.updateLaneConfig(laneId, "test/model", 0.2, 512, null, "full", 10, 32768)
        return laneId
    }

    private suspend fun waitForTerminal(store: WorkspaceStore, runId: String) {
        repeat(200) {
            if (store.isTerminal(runId)) return
            delay(25)
        }
        error("Run did not finish in time")
    }
}

private class RecordingOpenRouter(
    private val toolName: String = "mcp_tool_0",
    private val toolArguments: String = "{\"query\":\"safety\"}",
) : OpenRouterGateway {
    @Volatile var toolRoundCalls = 0
    @Volatile var standardStreamCalls = 0
    val messagesSeenByContinuation = java.util.Collections.synchronizedList(mutableListOf<List<JsonObject>>())

    override suspend fun stream(apiKey: String, config: LaneConfig, history: List<ContextMessage>, prompt: String, onText: suspend (String) -> Unit): JsonObject {
        standardStreamCalls++
        onText("Обычный ответ")
        return buildJsonObject { put("provider", "openrouter"); put("model", config.model) }
    }

    override suspend fun toolRound(apiKey: String, config: LaneConfig, messages: List<JsonObject>, tools: List<JsonObject>, onText: suspend (String) -> Unit): OpenRouterToolRound {
        toolRoundCalls++
        if (messages.any { it["role"]?.jsonPrimitive?.content == "tool" }) {
            messagesSeenByContinuation += messages
            assertTrue(messages.any { it["content"]?.jsonPrimitive?.content?.contains("structuredContent") == true || it["content"]?.jsonPrimitive?.content?.contains("Tool error:") == true })
            onText("Найдено в локальном каталоге.")
            return OpenRouterToolRound(buildJsonObject { put("role", "assistant"); put("content", "Найдено в локальном каталоге.") }, buildJsonObject { put("provider", "openrouter") })
        }
        assertEquals(1, tools.size)
        return OpenRouterToolRound(buildJsonObject {
            put("role", "assistant")
            put("content", kotlinx.serialization.json.JsonNull)
            put("tool_calls", buildJsonArray { add(buildJsonObject {
                put("id", "call-1"); put("type", "function")
                put("function", buildJsonObject { put("name", toolName); put("arguments", toolArguments) })
            }) })
        }, buildJsonObject { put("provider", "openrouter") })
    }

    override fun close() = Unit
}

private class NoopCodex : CodexGateway {
    override suspend fun status() = CodexStatus(true, "test")
    override suspend fun models() = JsonArray(emptyList())
    override suspend fun interrupt(threadId: String) = true
    override suspend fun beginLogin() = CodexLogin("https://example.invalid")
    override suspend fun stream(threadId: String?, prompt: String, contextToSeed: List<ContextMessage>, shouldSeedContext: Boolean, model: String,
        onThreadId: suspend (String) -> Unit, onContextSeeded: suspend () -> Unit, onContextSeedFailed: suspend () -> Unit,
        onText: suspend (String) -> Unit, ephemeral: Boolean, onUsage: suspend (JsonObject) -> Unit) {
        error("Codex is not part of this test")
    }
    override fun close() = Unit
}
