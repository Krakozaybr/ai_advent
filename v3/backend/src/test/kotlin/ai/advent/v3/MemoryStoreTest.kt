package ai.advent.v3

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class MemoryStoreTest {
    @Test
    fun `test manual layers stay separate by board and working memory across restart`() {
        val temp = Files.createTempDirectory("board-memory-store")
        val workspace = WorkspaceStore(temp.resolve("board.sqlite"))
        val boardA = workspace.boards().first().jsonObject["id"]!!.jsonPrimitive.content
        val boardB = workspace.createBoard()["board"]!!.jsonObject["id"]!!.jsonPrimitive.content
        val firstLane = workspace.createLane(boardA, "openrouter")["lanes"]!!.jsonArray.last().jsonObject["id"]!!.jsonPrimitive.content
        val memoryFile = temp.resolve("external-memory.sqlite")
        var memory = MemoryStore(memoryFile)
        memory.createWorkingMemory(boardA, "исследование")
        memory.createWorkingMemory(boardA, "черновик")
        memory.createWorkingMemory(boardB, "исследование")

        memory.upsert(boardA, "working", "исследование", "тема", "Северное сияние")
        memory.upsert(boardA, "working", "черновик", "тема", "Иная тема")
        memory.upsert(boardA, "longTerm", "", "язык", "русский")
        memory.upsert(boardB, "working", "исследование", "тема", "Чужая доска")

        assertFailsWith<IllegalStateException> { memory.validateProposal(workspace.laneDatabasePath(firstLane), firstLane, "working", "несуществующая") }
        assertEquals(2, memory.state(boardA)["workingMemories"]!!.jsonArray.size)
        assertEquals("русский", memory.state(boardA)["longTerm"]!!.jsonArray.single().jsonObject["value"]!!.jsonPrimitive.content)

        memory.deleteItem(boardA, "working", "исследование", "тема")
        memory.upsert(boardA, "working", "исследование", "снова", "запись")
        memory.clear(boardA, "working", "исследование")
        assertTrue(memory.state(boardA)["workingMemories"]!!.jsonArray.first { it.jsonObject["name"]!!.jsonPrimitive.content == "исследование" }.jsonObject["items"]!!.jsonArray.isEmpty())
        assertEquals("Иная тема", memory.state(boardA)["workingMemories"]!!.jsonArray.first { it.jsonObject["name"]!!.jsonPrimitive.content == "черновик" }.jsonObject["items"]!!.jsonArray.single().jsonObject["value"]!!.jsonPrimitive.content)
        assertEquals(1, memory.state(boardA)["longTerm"]!!.jsonArray.size)
        memory.clear(boardA, "longTerm")
        assertTrue(memory.state(boardA)["longTerm"]!!.jsonArray.isEmpty())

        memory.deleteWorkingMemory(boardA, "исследование")
        memory = MemoryStore(memoryFile)
        assertEquals("Иная тема", memory.state(boardA)["workingMemories"]!!.jsonArray.single().jsonObject["items"]!!.jsonArray.single().jsonObject["value"]!!.jsonPrimitive.content)
        assertTrue(memory.state(boardB)["workingMemories"]!!.jsonArray.single().jsonObject["items"]!!.jsonArray.single().jsonObject["value"]!!.jsonPrimitive.content == "Чужая доска")
        assertFalse(memory.state(boardA)["workingMemories"]!!.jsonArray.any { it.jsonObject["name"]!!.jsonPrimitive.content == "исследование" })
        workspace.close()
    }

    @Test
    fun `test MCP exposes scoped history and board memory without delete or scope arguments`() {
        val temp = Files.createTempDirectory("memory-mcp-tools")
        val workspace = WorkspaceStore(temp.resolve("board.sqlite"))
        val boardId = workspace.boards().first().jsonObject["id"]!!.jsonPrimitive.content
        val laneOne = workspace.createLane(boardId, "openrouter")["lanes"]!!.jsonArray.last().jsonObject["id"]!!.jsonPrimitive.content
        val laneTwo = workspace.createLane(boardId, "openrouter")["lanes"]!!.jsonArray.last().jsonObject["id"]!!.jsonPrimitive.content
        val otherBoard = workspace.createBoard()["board"]!!.jsonObject["id"]!!.jsonPrimitive.content
        val otherLane = workspace.createLane(otherBoard, "openrouter")["lanes"]!!.jsonArray.last().jsonObject["id"]!!.jsonPrimitive.content
        val memory = MemoryStore(temp.resolve("memory.sqlite"))
        memory.createWorkingMemory(boardId, "проект А")
        memory.createWorkingMemory(boardId, "проект Б")
        memory.createWorkingMemory(otherBoard, "проект А")
        memory.upsert(boardId, "working", "проект А", "секрет", "только первая лента")
        memory.upsert(boardId, "working", "проект Б", "секрет", "другая память")
        memory.upsert(boardId, "longTerm", "", "предпочтение", "общее для доски")
        val historical = workspace.startRun(laneOne, "старый маркер из начала ленты")
        workspace.failRun(historical.runId, "seed complete")
        val recent = workspace.startRun(laneOne, "свежее сообщение")
        workspace.failRun(recent.runId, "seed complete")
        val slidingPlan = ContextPlanner.plan(workspace.contextSnapshot(laneOne).messages, "проверь историю", ContextStrategy.SLIDING_WINDOW, 1, "", null, 32_768, 100)
        assertFalse(slidingPlan.messages.any { it.content.contains("старый маркер") })
        assertEquals(1, slidingPlan.omittedMessages)

        val root = generateSequence(Path.of("").toAbsolutePath()) { it.parent }
            .first { Files.isRegularFile(it.resolve("examples/mcp/lane-history-server.mjs")) }
        val historyConfig = McpServerConfig("lane-history", "History", "", "node", listOf(root.resolve("examples/mcp/lane-history-server.mjs").toString()), root.toString())
        val memoryConfig = McpServerConfig("board-memory", "Memory", "", "node", listOf(root.resolve("examples/mcp/board-memory-server.mjs").toString()), root.toString())
        val client = McpClient()
        val laneOneHistory = scopedMcpServer(historyConfig, workspace.laneDatabasePath(laneOne), laneOne, memory.databasePath)
        val laneTwoHistory = scopedMcpServer(historyConfig, workspace.laneDatabasePath(laneTwo), laneTwo, memory.databasePath)
        val otherHistory = scopedMcpServer(historyConfig, workspace.laneDatabasePath(otherLane), otherLane, memory.databasePath)
        val found = client.call(laneOneHistory, "history_search", buildJsonObject { put("query", "старый маркер") })
        assertTrue(found.toString().contains("старый маркер из начала ленты"))
        val oldMessageId = found["structuredContent"]!!.jsonObject["messages"]!!.jsonArray.single().jsonObject["id"]!!.jsonPrimitive.content
        assertTrue(client.call(laneOneHistory, "history_get", buildJsonObject { put("messageId", oldMessageId) }).toString().contains("старый маркер из начала ленты"))
        assertFalse(client.call(laneTwoHistory, "history_search", buildJsonObject { put("query", "старый маркер") }).toString().contains("старый маркер из начала ленты"))
        assertFalse(client.call(otherHistory, "history_search", buildJsonObject { put("query", "старый маркер") }).toString().contains("старый маркер из начала ленты"))
        assertFailsWith<IllegalArgumentException> { client.call(laneOneHistory, "history_search", buildJsonObject { put("query", "старый маркер"); put("laneId", laneTwo) }) }

        val laneOneMemory = scopedMcpServer(memoryConfig, workspace.laneDatabasePath(laneOne), laneOne, memory.databasePath)
        val laneTwoMemory = scopedMcpServer(memoryConfig, workspace.laneDatabasePath(laneTwo), laneTwo, memory.databasePath)
        val listed = client.call(laneOneMemory, "memory_list", buildJsonObject {})
        assertTrue(listed.toString().contains("проект А") && listed.toString().contains("проект Б"))
        val parallelReads = listOf(
            CompletableFuture.supplyAsync { client.call(laneOneMemory, "memory_read", buildJsonObject { put("layer", "working"); put("memoryName", "проект А") }).toString() },
            CompletableFuture.supplyAsync { client.call(laneTwoMemory, "memory_read", buildJsonObject { put("layer", "working"); put("memoryName", "проект Б") }).toString() },
        ).map { it.get() }
        assertTrue(parallelReads[0].contains("только первая лента"))
        assertTrue(parallelReads[1].contains("другая память"))
        assertTrue(client.call(laneOneMemory, "memory_read", buildJsonObject { put("layer", "longTerm") }).toString().contains("общее для доски"))
        assertTrue(client.call(laneTwoMemory, "memory_read", buildJsonObject { put("layer", "longTerm") }).toString().contains("общее для доски"))
        assertFailsWith<IllegalStateException> { client.call(laneOneMemory, "memory_read", buildJsonObject { put("layer", "working"); put("memoryName", "подменённая") }) }
        assertFailsWith<IllegalArgumentException> { client.call(laneOneMemory, "memory_read", buildJsonObject { put("layer", "working"); put("memoryName", "проект А"); put("boardId", otherBoard) }) }

        val historyNames = client.listTools(historyConfig).map { it.name }.toSet()
        val memoryTools = client.listTools(memoryConfig)
        assertEquals(setOf("history_search", "history_get"), historyNames)
        assertTrue(client.listTools(historyConfig).all { it.readOnly })
        assertTrue(memoryTools.all { it.name !in setOf("delete", "clear", "memory_delete") })
        assertTrue(memoryTools.filter { it.name in setOf("memory_list", "memory_read") }.all { it.readOnly })
        assertFalse(memoryTools.single { it.name == "memory_propose_write" }.readOnly)
        val proposalSchema = memoryTools.single { it.name == "memory_propose_write" }.inputSchema
        assertFalse(proposalSchema["properties"]!!.jsonObject.containsKey("boardId"))
        assertFalse(proposalSchema["properties"]!!.jsonObject.containsKey("laneId"))
        McpClient.validateSchema(buildJsonObject { put("layer", "working"); put("memoryName", "проект А"); put("key", "k"); put("value", "v"); put("reason", "r") }, proposalSchema)
        assertFailsWith<IllegalArgumentException> { McpClient.validateSchema(buildJsonObject { put("layer", "working"); put("memoryName", "проект А"); put("key", "k"); put("value", "v"); put("reason", "r"); put("laneId", laneTwo) }, proposalSchema) }
        workspace.close()
    }
}
