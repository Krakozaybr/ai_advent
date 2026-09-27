package ai.advent.v3

import kotlinx.coroutines.delay
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CompletableDeferred
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
import java.sql.DriverManager
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.assertNotNull

class RunCoordinatorMcpTest {
    @Test
    fun `approval decisions are atomic and interrupted applying approvals require manual closure`() = runBlocking {
        val temp = Files.createTempDirectory("v3-approval-recovery")
        val database = temp.resolve("board.sqlite")
        var store = WorkspaceStore(database)
        val boardId = store.boards().first().jsonObject["id"]!!.jsonPrimitive.content
        val lane = createOpenRouterLane(store, boardId)
        val approvalId = store.addMcpApproval(lane, "sticky-facts", "update_fact", buildJsonObject {}, "test", null)
        val otherStore = WorkspaceStore(database)
        try {
            val start = CompletableDeferred<Unit>()
            val (claimed, denied) = coroutineScope {
                val approve = async(Dispatchers.IO) { start.await(); store.claimApproval(lane, approvalId) }
                val deny = async(Dispatchers.IO) { start.await(); otherStore.denyApproval(lane, approvalId) }
                start.complete(Unit)
                approve.await() to deny.await()
            }
            assertTrue((claimed != null) xor denied, "Exactly one pending -> applying or pending -> denied transition may win")
            if (claimed != null) {
                assertEquals("applying", claimed["status"]!!.jsonPrimitive.content)
                assertFalse(otherStore.denyApproval(lane, approvalId))
                assertTrue(store.finishApproval(lane, approvalId, "approved", "user"))
            } else {
                assertEquals("denied", store.approval(lane, approvalId)!!["status"]!!.jsonPrimitive.content)
                assertFalse(store.finishApproval(lane, approvalId, "approved", "user"))
            }

            val interruptedId = store.addMcpApproval(lane, "sticky-facts", "update_fact", buildJsonObject {}, "restart", null)
            assertNotNull(store.claimApproval(lane, interruptedId))
            store.close()
            otherStore.close()

            // Simulate a pre-migration SQLite file, which has no interrupted_at column.
            DriverManager.getConnection("jdbc:sqlite:${database.toAbsolutePath()}").use { db ->
                db.createStatement().use { it.execute("ALTER TABLE mcp_approvals DROP COLUMN interrupted_at") }
            }
            store = WorkspaceStore(database)
            val recovered = store.approval(lane, interruptedId)!!
            assertEquals("uncertain", recovered["status"]!!.jsonPrimitive.content)
            assertTrue(recovered["interruptedAt"]!!.jsonPrimitive.content.isNotBlank())
            assertTrue(store.claimApproval(lane, interruptedId) == null, "Recovery must not replay the external MCP call")
            assertFalse(store.finishApproval(lane, interruptedId, "approved", "user"))
            assertTrue(store.closeUncertainApproval(lane, interruptedId))
            assertEquals("uncertain_closed", store.approval(lane, interruptedId)!!["status"]!!.jsonPrimitive.content)
            assertTrue(store.claimApproval(lane, interruptedId) == null)
        } finally {
            otherStore.close()
            store.close()
        }
    }

    @Test
    fun `test board memory writes wait for approval and reject unavailable working memory`() = runBlocking {
        val temp = Files.createTempDirectory("v3-board-memory-proposal")
        val store = WorkspaceStore(temp.resolve("board.sqlite"))
        val boardId = store.boards().first().jsonObject["id"]!!.jsonPrimitive.content
        val lane = createOpenRouterLane(store, boardId)
        val memories = MemoryStore(temp.resolve("external-memory.sqlite"))
        memories.createWorkingMemory(boardId, "созданная память")
        val toolArgs = """{"layer":"working","memoryName":"созданная память","key":"решение","value":"ожидает подтверждения","reason":"проверка"}"""
        val invalidArgs = """{"layer":"working","memoryName":"несуществующая","key":"bad","value":"bad","reason":"проверка"}"""
        store.saveMcpTools(lane, listOf(McpSelection("board-memory", "memory_propose_write")))
        val root = Path.of(System.getProperty("user.dir")).toAbsolutePath().parent.parent
        val server = McpServerConfig("board-memory", "Memory", "", "node", listOf(root.resolve("examples/mcp/board-memory-server.mjs").toString()), root.toString())
        val coordinator = RunCoordinator(store, NoopCodex(), RecordingOpenRouter("mcp_tool_0", toolArgs),
            OpenRouterKeyStore(temp.resolve("key")).also { it.save("test-server-key-only") }, McpRegistry(listOf(server)), memoryStore = memories)
        try {
            val pendingRun = coordinator.submit(lane, "Предложи запись")
            waitForTerminal(store, pendingRun)
            val pending = store.laneSnapshot(lane)["mcpApprovals"]!!.jsonArray.single().jsonObject
            assertEquals("pending", pending["status"]!!.jsonPrimitive.content)
            assertEquals("working", pending["arguments"]!!.jsonObject["layer"]!!.jsonPrimitive.content)
            assertEquals("созданная память", pending["arguments"]!!.jsonObject["memoryName"]!!.jsonPrimitive.content)
            assertEquals("решение", pending["arguments"]!!.jsonObject["key"]!!.jsonPrimitive.content)
            assertEquals("ожидает подтверждения", pending["arguments"]!!.jsonObject["value"]!!.jsonPrimitive.content)
            assertTrue(memories.state(boardId)["workingMemories"]!!.jsonArray.single().jsonObject["items"]!!.jsonArray.isEmpty())

            val invalidCoordinator = RunCoordinator(store, NoopCodex(), RecordingOpenRouter("mcp_tool_0", invalidArgs),
                OpenRouterKeyStore(temp.resolve("key")), McpRegistry(listOf(server)), memoryStore = memories)
            try {
                val invalidRun = invalidCoordinator.submit(lane, "Несуществующая память")
                waitForTerminal(store, invalidRun)
                assertEquals(1, store.laneSnapshot(lane)["mcpApprovals"]!!.jsonArray.size)
                assertTrue(memories.state(boardId)["workingMemories"]!!.jsonArray.single().jsonObject["items"]!!.jsonArray.isEmpty())
            } finally { invalidCoordinator.close() }
        } finally { coordinator.close(); store.close() }
    }

    @Test
    fun `parallel lane proposals remain isolated and independently approvable`() = runBlocking {
        val temp = Files.createTempDirectory("v3-facts-parallel")
        val database = temp.resolve("board.sqlite")
        val store = WorkspaceStore(database)
        val boardId = store.boards().first().jsonObject["id"]!!.jsonPrimitive.content
        val laneA = createOpenRouterLane(store, boardId)
        val laneB = createOpenRouterLane(store, boardId)
        store.saveMcpTools(laneA, listOf(McpSelection("sticky-facts", "update_fact")))
        store.saveMcpTools(laneB, listOf(McpSelection("sticky-facts", "update_fact")))
        val root = Path.of(System.getProperty("user.dir")).toAbsolutePath().parent.parent
        val factsServer = McpServerConfig("sticky-facts", "Facts", "", "node", listOf(root.resolve("examples/mcp/sticky-facts-server.mjs").toString()), root.toString())
        val coordinator = RunCoordinator(store, NoopCodex(), ParallelFactsOpenRouter(),
            OpenRouterKeyStore(temp.resolve("key")).also { it.save("test-server-key-only") }, McpRegistry(listOf(factsServer)))
        try {
            val (runA, runB) = coroutineScope {
                val a = async { coordinator.submit(laneA, "fact-a") }
                val b = async { coordinator.submit(laneB, "fact-b") }
                a.await() to b.await()
            }
            waitForTerminal(store, runA); waitForTerminal(store, runB)
            val approvalA = store.laneSnapshot(laneA)["mcpApprovals"]!!.jsonArray.single().jsonObject
            val approvalB = store.laneSnapshot(laneB)["mcpApprovals"]!!.jsonArray.single().jsonObject
            assertEquals("pending", approvalA["status"]!!.jsonPrimitive.content)
            assertEquals("pending", approvalB["status"]!!.jsonPrimitive.content)
            listOf(laneA to approvalA, laneB to approvalB).forEach { (lane, approval) ->
                val id = approval["id"]!!.jsonPrimitive.content
                val claimed = assertNotNull(store.claimApproval(lane, id))
                val scoped = factsServer.copy(environment = mapOf("AI_ADVENT_V3_BOARD_DB" to database.toAbsolutePath().toString(), "AI_ADVENT_V3_LANE_ID" to lane))
                McpClient().call(scoped, "update_fact", claimed["arguments"]!!.jsonObject)
                store.finishApproval(lane, id, "approved", "user")
            }
            assertEquals("fact-a", store.laneSnapshot(laneA)["stickyFacts"]!!.jsonArray.single().jsonObject["value"]!!.jsonPrimitive.content)
            assertEquals("fact-b", store.laneSnapshot(laneB)["stickyFacts"]!!.jsonArray.single().jsonObject["value"]!!.jsonPrimitive.content)
        } finally { coordinator.close(); store.close() }
    }

    @Test
    fun `autoapprove is opt in and records its source while manual facts can be changed and cleared`() = runBlocking {
        val temp = Files.createTempDirectory("v3-facts-autoapprove")
        val store = WorkspaceStore(temp.resolve("board.sqlite"))
        val boardId = store.boards().first().jsonObject["id"]!!.jsonPrimitive.content
        val lane = createOpenRouterLane(store, boardId)
        store.saveMcpTools(lane, listOf(McpSelection("sticky-facts", "read_facts"), McpSelection("sticky-facts", "update_fact")))
        store.setMcpAutoApprove(lane, true)
        val root = Path.of(System.getProperty("user.dir")).toAbsolutePath().parent.parent
        val server = McpServerConfig("sticky-facts", "Facts", "", "node", listOf(root.resolve("examples/mcp/sticky-facts-server.mjs").toString()), root.toString())
        val coordinator = RunCoordinator(store, NoopCodex(), ScriptedFactsOpenRouter(),
            OpenRouterKeyStore(temp.resolve("key")).also { it.save("test-server-key-only") }, McpRegistry(listOf(server)))
        try {
            val run = coordinator.submit(lane, "Сохрани предпочтение")
            waitForTerminal(store, run)
            val state = store.laneSnapshot(lane)
            assertTrue(state["stickyFacts"]!!.jsonArray.any { it.jsonObject["key"]!!.jsonPrimitive.content == "preferred_language" })
            val approval = state["mcpApprovals"]!!.jsonArray.single().jsonObject
            assertEquals("approved", approval["status"]!!.jsonPrimitive.content)
            assertEquals("lane-autoapprove", approval["approvalSource"]!!.jsonPrimitive.content)
            store.editFact(lane, "manually_corrected", "исправлено пользователем")
            assertTrue(store.laneSnapshot(lane)["stickyFacts"]!!.jsonArray.any { it.jsonObject["value"]!!.jsonPrimitive.content == "исправлено пользователем" })
            store.clearFacts(lane)
            assertTrue(store.laneSnapshot(lane)["stickyFacts"]!!.jsonArray.isEmpty())
        } finally { coordinator.close(); store.close() }
    }

    @Test
    fun `facts wait for approval and are visible to next run in isolated persistent lane scope`() = runBlocking {
        val temp = Files.createTempDirectory("v3-sticky-facts")
        val dbPath = temp.resolve("board.sqlite")
        var store = WorkspaceStore(dbPath)
        val boardId = store.boards().first().jsonObject["id"]!!.jsonPrimitive.content
        val lane = createOpenRouterLane(store, boardId)
        val otherLane = createOpenRouterLane(store, boardId)
        val root = Path.of(System.getProperty("user.dir")).toAbsolutePath().parent.parent
        val factsServer = McpServerConfig("sticky-facts", "Facts", "", "node",
            listOf(root.resolve("examples/mcp/sticky-facts-server.mjs").toString()), root.toString())
        val selections = listOf(McpSelection("sticky-facts", "read_facts"), McpSelection("sticky-facts", "update_fact"))
        store.saveMcpTools(lane, selections)
        store.saveMcpTools(otherLane, selections)
        val gateway = ScriptedFactsOpenRouter()
        val keys = OpenRouterKeyStore(temp.resolve("openrouter.key")).also { it.save("test-server-key-only") }
        var coordinator = RunCoordinator(store, NoopCodex(), gateway, keys, McpRegistry(listOf(factsServer)))
        try {
            val proposedRun = coordinator.submit(lane, "Запомни, что я предпочитаю русский язык")
            waitForTerminal(store, proposedRun)
            val pendingBoard = store.laneSnapshot(lane)
            assertEquals(1, pendingBoard["mcpApprovals"]!!.jsonArray.size, pendingBoard.toString() + store.eventsAfter(proposedRun, 0).joinToString { it.second.toString() })
            val approval = pendingBoard["mcpApprovals"]!!.jsonArray.single().jsonObject
            assertEquals("pending", approval["status"]!!.jsonPrimitive.content)
            assertTrue(approval["arguments"].toString().contains("русский язык"))
            assertTrue(pendingBoard["stickyFacts"]!!.jsonArray.isEmpty())
            assertTrue(gateway.continuations.first().last { it["role"]?.jsonPrimitive?.content == "tool" }["content"]!!.jsonPrimitive.content.contains("pending approval"))

            val approvalId = approval["id"]!!.jsonPrimitive.content
            val claimed = assertNotNull(store.claimApproval(lane, approvalId))
            val approvedArgs = claimed["arguments"]!!.jsonObject
            val scopedServer = factsServer.copy(environment = mapOf("AI_ADVENT_V3_BOARD_DB" to dbPath.toAbsolutePath().toString(), "AI_ADVENT_V3_LANE_ID" to lane))
            McpClient().call(scopedServer, "update_fact", approvedArgs)
            store.finishApproval(lane, approvalId, "approved", "user")
            assertEquals("approved", store.approval(lane, approvalId)!!["status"]!!.jsonPrimitive.content)
            assertTrue(store.claimApproval(lane, approvalId) == null, "A duplicate approval must not execute twice")

            coordinator.close()
            store.close()
            store = WorkspaceStore(dbPath)
            assertEquals("русский язык", store.laneSnapshot(lane)["stickyFacts"]!!.jsonArray.single().jsonObject["value"]!!.jsonPrimitive.content)
            assertTrue(store.laneSnapshot(otherLane)["stickyFacts"]!!.jsonArray.isEmpty())
            coordinator = RunCoordinator(store, NoopCodex(), gateway, keys, McpRegistry(listOf(factsServer)))
            val readRun = coordinator.submit(lane, "Какой язык я предпочитаю?")
            waitForTerminal(store, readRun)
            assertTrue(gateway.continuations.last().last { it["role"]?.jsonPrimitive?.content == "tool" }["content"]!!.jsonPrimitive.content.contains("русский язык"), gateway.continuations.toString() + store.eventsAfter(readRun, 0).joinToString { it.second.toString() })
        } finally {
            coordinator.close()
            store.close()
        }
    }

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

    @Test
    fun `sticky facts reject model supplied board and lane scope arguments`() = runBlocking {
        val temp = Files.createTempDirectory("v3-facts-scope-args")
        val store = WorkspaceStore(temp.resolve("board.sqlite"))
        val boardId = store.boards().first().jsonObject["id"]!!.jsonPrimitive.content
        val lane = createOpenRouterLane(store, boardId)
        val root = Path.of(System.getProperty("user.dir")).toAbsolutePath().parent.parent
        val server = McpServerConfig("sticky-facts", "Facts", "", "node", listOf(root.resolve("examples/mcp/sticky-facts-server.mjs").toString()), root.toString())
        store.saveMcpTools(lane, listOf(McpSelection("sticky-facts", "update_fact")))
        val coordinator = RunCoordinator(store, NoopCodex(), RecordingOpenRouter("mcp_tool_0",
            """{"key":"other","value":"bad","reason":"bad","boardId":"outside","laneId":"elsewhere"}"""),
            OpenRouterKeyStore(temp.resolve("key")).also { it.save("test-server-key-only") }, McpRegistry(listOf(server)))
        try {
            val run = coordinator.submit(lane, "Предложи факт")
            waitForTerminal(store, run)
            assertTrue(store.laneSnapshot(lane)["stickyFacts"]!!.jsonArray.isEmpty())
            assertTrue(store.laneSnapshot(lane)["mcpApprovals"]!!.jsonArray.isEmpty())
            val events = store.eventsAfter(run, 0).map { it.second.toString() }
            assertTrue(events.any { it.contains("unknown fields") })
        } finally { coordinator.close(); store.close() }
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
        error("Run did not finish in time: ${store.eventsAfter(runId, 0)}")
    }
}

private class ScriptedFactsOpenRouter : OpenRouterGateway {
    private val nextTools = java.util.concurrent.ConcurrentLinkedQueue(listOf(
        "mcp_tool_1" to """{"key":"preferred_language","value":"русский язык","reason":"Указанное пользователем предпочтение"}""",
        "mcp_tool_0" to "{}",
    ))
    val continuations = java.util.Collections.synchronizedList(mutableListOf<List<JsonObject>>())

    override suspend fun stream(apiKey: String, config: LaneConfig, history: List<ContextMessage>, prompt: String, onText: suspend (String) -> Unit, instructions: String): JsonObject = buildJsonObject { put("provider", "openrouter") }

    override suspend fun toolRound(apiKey: String, config: LaneConfig, messages: List<JsonObject>, tools: List<JsonObject>, onText: suspend (String) -> Unit, instructions: String): OpenRouterToolRound {
        if (messages.any { it["role"]?.jsonPrimitive?.content == "tool" }) {
            continuations += messages
            onText("Проверил сохранённые факты.")
            return OpenRouterToolRound(buildJsonObject { put("role", "assistant"); put("content", "Проверил сохранённые факты.") }, buildJsonObject { put("provider", "openrouter") })
        }
        if (tools.isEmpty()) {
            continuations += messages
            onText("Предложение передано пользователю; ожидает подтверждения.")
            return OpenRouterToolRound(buildJsonObject { put("role", "assistant"); put("content", "Предложение ожидает подтверждения.") }, buildJsonObject { put("provider", "openrouter") })
        }
        val script = nextTools.poll() ?: ("mcp_tool_0" to "{}")
        return OpenRouterToolRound(buildJsonObject {
            put("role", "assistant"); put("content", kotlinx.serialization.json.JsonNull)
            put("tool_calls", buildJsonArray { add(buildJsonObject {
                put("id", "call-${System.nanoTime()}"); put("type", "function")
                put("function", buildJsonObject { put("name", script.first); put("arguments", if (script.second.isBlank()) "{}" else script.second) })
            }) })
        }, buildJsonObject { put("provider", "openrouter") })
    }

    override fun close() = Unit
}

private class ParallelFactsOpenRouter : OpenRouterGateway {
    override suspend fun stream(apiKey: String, config: LaneConfig, history: List<ContextMessage>, prompt: String, onText: suspend (String) -> Unit, instructions: String) = buildJsonObject { put("provider", "openrouter") }
    override suspend fun toolRound(apiKey: String, config: LaneConfig, messages: List<JsonObject>, tools: List<JsonObject>, onText: suspend (String) -> Unit, instructions: String): OpenRouterToolRound {
        if (messages.any { it["role"]?.jsonPrimitive?.content == "tool" }) {
            onText("Ожидает подтверждения пользователя.")
            return OpenRouterToolRound(buildJsonObject { put("role", "assistant"); put("content", "Ожидает подтверждения.") }, buildJsonObject { put("provider", "openrouter") })
        }
        val factValue = messages.last { it["role"]?.jsonPrimitive?.content == "user" }["content"]!!.jsonPrimitive.content
        return OpenRouterToolRound(buildJsonObject {
            put("role", "assistant"); put("content", kotlinx.serialization.json.JsonNull)
            put("tool_calls", buildJsonArray { add(buildJsonObject {
                put("id", "call-$factValue"); put("type", "function")
                put("function", buildJsonObject { put("name", "mcp_tool_0"); put("arguments", """{"key":"parallel","value":"$factValue","reason":"test"}""") })
            }) })
        }, buildJsonObject { put("provider", "openrouter") })
    }
    override fun close() = Unit
}

private class RecordingOpenRouter(
    private val toolName: String = "mcp_tool_0",
    private val toolArguments: String = "{\"query\":\"safety\"}",
) : OpenRouterGateway {
    @Volatile var toolRoundCalls = 0
    @Volatile var standardStreamCalls = 0
    val messagesSeenByContinuation = java.util.Collections.synchronizedList(mutableListOf<List<JsonObject>>())

    override suspend fun stream(apiKey: String, config: LaneConfig, history: List<ContextMessage>, prompt: String, onText: suspend (String) -> Unit, instructions: String): JsonObject {
        standardStreamCalls++
        onText("Обычный ответ")
        return buildJsonObject { put("provider", "openrouter"); put("model", config.model) }
    }

    override suspend fun toolRound(apiKey: String, config: LaneConfig, messages: List<JsonObject>, tools: List<JsonObject>, onText: suspend (String) -> Unit, instructions: String): OpenRouterToolRound {
        toolRoundCalls++
        if (messages.any { it["role"]?.jsonPrimitive?.content == "tool" }) {
            messagesSeenByContinuation += messages
            assertTrue(messages.any { item ->
                val content = item["content"]?.jsonPrimitive?.content.orEmpty()
                content.contains("structuredContent") || content.contains("Tool error:") || content.contains("pending approval")
            })
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
        onText: suspend (String) -> Unit, ephemeral: Boolean, onUsage: suspend (JsonObject) -> Unit, developerInstructions: String) {
        error("Codex is not part of this test")
    }
    override fun close() = Unit
}
