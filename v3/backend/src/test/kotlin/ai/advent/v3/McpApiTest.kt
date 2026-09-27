package ai.advent.v3

import io.ktor.client.request.get
import io.ktor.client.request.delete
import io.ktor.client.request.header
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class McpApiTest {
    @Test
    fun `test board memory approval and manual layers persist independently`() = testApplication {
        val temp = Files.createTempDirectory("board-memory-api")
        val boardDatabase = temp.resolve("board.sqlite")
        val store = WorkspaceStore(boardDatabase)
        val boardId = store.boards().first().jsonObject["id"]!!.jsonPrimitive.content
        val laneId = store.createLane(boardId, "openrouter")["lanes"]!!.jsonArray.last().jsonObject["id"]!!.jsonPrimitive.content
        val memories = MemoryStore(temp.resolve("external-memory.sqlite"))
        memories.createWorkingMemory(boardId, "проект А")
        val proposalArgs = buildJsonObject {
            put("layer", "working"); put("memoryName", "проект А"); put("key", "решение"); put("value", "до подтверждения нет записи"); put("reason", "проверка approval")
        }
        val approvalId = store.addMcpApproval(laneId, "board-memory", "memory_propose_write", proposalArgs, "проверка approval", null)
        assertTrue(memories.state(boardId)["workingMemories"]!!.jsonArray.first { it.jsonObject["name"]!!.jsonPrimitive.content == "проект А" }.jsonObject["items"]!!.jsonArray.isEmpty())
        val root = generateSequence(Path.of("").toAbsolutePath()) { it.parent }
            .first { Files.isRegularFile(it.resolve("examples/mcp/board-memory-server.mjs")) }
        val server = McpServerConfig("board-memory", "Память доски", "test", "node",
            listOf(root.resolve("examples/mcp/board-memory-server.mjs").toString()), root.toString())
        application { module(store, TestCodex(), OpenRouterHttpGateway(), OpenRouterKeyStore(temp.resolve("key")), McpRegistry(listOf(server)), memoryStore = memories) }

        val createdMemory = client.post("/api/boards/$boardId/memories/working") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString()); setBody("""{"name":"ручная"}""")
        }
        assertEquals(HttpStatusCode.Created, createdMemory.status)
        assertEquals(HttpStatusCode.OK, client.get("/api/boards/$boardId/memories").status)

        val approvalResponse = client.post("/api/lanes/$laneId/mcp-approvals/$approvalId") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString()); setBody("""{"decision":"approve"}""")
        }
        assertEquals(HttpStatusCode.OK, approvalResponse.status)
        assertEquals("approved", store.approval(laneId, approvalId)!!["status"]!!.jsonPrimitive.content)
        assertEquals("до подтверждения нет записи", memories.state(boardId)["workingMemories"]!!.jsonArray.first { it.jsonObject["name"]!!.jsonPrimitive.content == "проект А" }.jsonObject["items"]!!.jsonArray.single().jsonObject["value"]!!.jsonPrimitive.content)

        val manualWorking = client.patch("/api/boards/$boardId/memories/working/%D1%80%D1%83%D1%87%D0%BD%D0%B0%D1%8F/%D1%80%D1%83%D1%87%D0%BD%D0%BE") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString()); setBody("""{"value":"отредактировано вручную"}""")
        }
        assertEquals(HttpStatusCode.OK, manualWorking.status)
        val manualLongTerm = client.patch("/api/boards/$boardId/memories/longTerm/-/%D0%BD%D0%B0%D0%B4%D0%BE%D0%BB%D0%B3%D0%BE") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString()); setBody("""{"value":"общая запись"}""")
        }
        assertEquals(HttpStatusCode.OK, manualLongTerm.status)
        val clearWorking = client.delete("/api/boards/$boardId/memories/working/%D1%80%D1%83%D1%87%D0%BD%D0%B0%D1%8F")
        assertEquals(HttpStatusCode.OK, clearWorking.status)
        val stateAfterWorkingClear = memories.state(boardId)
        assertTrue(stateAfterWorkingClear["workingMemories"]!!.jsonArray.first { it.jsonObject["name"]!!.jsonPrimitive.content == "ручная" }.jsonObject["items"]!!.jsonArray.isEmpty())
        assertEquals("общая запись", stateAfterWorkingClear["longTerm"]!!.jsonArray.single().jsonObject["value"]!!.jsonPrimitive.content)
        val clearLongTerm = client.delete("/api/boards/$boardId/memories/longTerm/-")
        assertEquals(HttpStatusCode.OK, clearLongTerm.status)
        assertTrue(memories.state(boardId)["longTerm"]!!.jsonArray.isEmpty())

        val unavailableMemory = client.patch("/api/boards/$boardId/memories/working/unknown/key") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString()); setBody("""{"value":"no"}""")
        }
        assertEquals(HttpStatusCode.NotFound, unavailableMemory.status)

        store.close()
        val reopenedBoard = WorkspaceStore(boardDatabase)
        val reopenedMemory = MemoryStore(temp.resolve("external-memory.sqlite"))
        assertEquals("approved", reopenedBoard.approval(laneId, approvalId)!!["status"]!!.jsonPrimitive.content)
        assertTrue(reopenedMemory.state(boardId)["longTerm"]!!.jsonArray.isEmpty())
        assertEquals("до подтверждения нет записи", reopenedMemory.state(boardId)["workingMemories"]!!.jsonArray.first { it.jsonObject["name"]!!.jsonPrimitive.content == "проект А" }.jsonObject["items"]!!.jsonArray.single().jsonObject["value"]!!.jsonPrimitive.content)
        reopenedBoard.close()
    }

    @Test
    fun `catalog and selection errors do not reveal MCP command paths`() = testApplication {
        val temp = Files.createTempDirectory("mcp-error-sanitization")
        val store = WorkspaceStore(temp.resolve("board.sqlite"))
        val boardId = store.boards().first().jsonObject["id"]!!.jsonPrimitive.content
        val lane = store.createLane(boardId, "openrouter")["lanes"]!!.jsonArray.last().jsonObject["id"]!!.jsonPrimitive.content
        val registry = McpRegistry(listOf(McpServerConfig("broken", "Broken", "", "/private/secret/mcp", emptyList(), "/private/secret/cwd")))
        application { module(store, TestCodex(), OpenRouterHttpGateway(), OpenRouterKeyStore(temp.resolve("key")), registry) }
        val catalog = client.get("/api/mcp/catalog").bodyAsText()
        assertFalse(catalog.contains("/private/secret"))
        val attempt = client.patch("/api/lanes/$lane/mcp-tools") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"tools":[{"serverId":"broken","toolName":"search"}]}""")
        }
        assertEquals(HttpStatusCode.BadGateway, attempt.status)
        assertFalse(attempt.bodyAsText().contains("/private/secret"))
    }

    @Test
    fun `approval route applies scoped fact once and manual fact controls persist`() = testApplication {
        val temp = Files.createTempDirectory("sticky-facts-api")
        val dbPath = temp.resolve("board.sqlite")
        val store = WorkspaceStore(dbPath)
        val boardId = store.boards().first().jsonObject["id"]!!.jsonPrimitive.content
        val created = store.createLane(boardId, "openrouter")
        val laneId = created["lanes"]!!.jsonArray.last().jsonObject["id"]!!.jsonPrimitive.content
        val approvalId = store.addMcpApproval(laneId, "sticky-facts", "update_fact", buildJsonObject {
            put("key", "preferred_language"); put("value", "Русский"); put("reason", "Указанное предпочтение")
        }, "Указанное предпочтение", null)
        val root = generateSequence(Path.of("").toAbsolutePath()) { it.parent }
            .first { Files.isRegularFile(it.resolve("examples/mcp/sticky-facts-server.mjs")) }
        val server = McpServerConfig("sticky-facts", "Постоянные факты", "test", "node",
            listOf(root.resolve("examples/mcp/sticky-facts-server.mjs").toString()), root.toString())
        application { module(store, TestCodex(), OpenRouterHttpGateway(), OpenRouterKeyStore(temp.resolve("key")), McpRegistry(listOf(server))) }

        val approvalUrl = "/api/lanes/$laneId/mcp-approvals/$approvalId"
        val approved = client.post(approvalUrl) {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"decision":"approve"}""")
        }
        assertEquals(HttpStatusCode.OK, approved.status)
        var lane = Json.parseToJsonElement(approved.bodyAsText()).jsonObject["lanes"]!!.jsonArray
            .first { it.jsonObject["id"]!!.jsonPrimitive.content == laneId }.jsonObject
        assertEquals("Русский", lane["stickyFacts"]!!.jsonArray.single().jsonObject["value"]!!.jsonPrimitive.content)
        assertEquals("approved", lane["mcpApprovals"]!!.jsonArray.single().jsonObject["status"]!!.jsonPrimitive.content)

        val duplicate = client.post(approvalUrl) {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"decision":"approve"}""")
        }
        assertEquals(HttpStatusCode.OK, duplicate.status)
        lane = Json.parseToJsonElement(duplicate.bodyAsText()).jsonObject["lanes"]!!.jsonArray
            .first { it.jsonObject["id"]!!.jsonPrimitive.content == laneId }.jsonObject
        assertEquals(1, lane["stickyFacts"]!!.jsonArray.size)

        val edited = client.patch("/api/lanes/$laneId/facts") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"key":"preferred_language","value":"English"}""")
        }
        assertEquals("English", Json.parseToJsonElement(edited.bodyAsText()).jsonObject["lanes"]!!.jsonArray
            .first { it.jsonObject["id"]!!.jsonPrimitive.content == laneId }.jsonObject["stickyFacts"]!!.jsonArray.single().jsonObject["value"]!!.jsonPrimitive.content)
        val cleared = client.delete("/api/lanes/$laneId/facts")
        lane = Json.parseToJsonElement(cleared.bodyAsText()).jsonObject["lanes"]!!.jsonArray
            .first { it.jsonObject["id"]!!.jsonPrimitive.content == laneId }.jsonObject
        assertTrue(lane["stickyFacts"]!!.jsonArray.isEmpty())

        val optIn = client.patch("/api/lanes/$laneId/mcp-approval-settings") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"autoApprove":true}""")
        }
        assertEquals(true, Json.parseToJsonElement(optIn.bodyAsText()).jsonObject["lanes"]!!.jsonArray
            .first { it.jsonObject["id"]!!.jsonPrimitive.content == laneId }.jsonObject["mcpAutoApprove"]!!.jsonPrimitive.content.toBoolean())

        val deniedId = store.addMcpApproval(laneId, "sticky-facts", "update_fact", buildJsonObject {
            put("key", "must_not_exist"); put("value", "blocked"); put("reason", "denial check")
        }, "denial check", null)
        val denied = client.post("/api/lanes/$laneId/mcp-approvals/$deniedId") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"decision":"deny"}""")
        }
        lane = Json.parseToJsonElement(denied.bodyAsText()).jsonObject["lanes"]!!.jsonArray
            .first { it.jsonObject["id"]!!.jsonPrimitive.content == laneId }.jsonObject
        assertEquals("denied", lane["mcpApprovals"]!!.jsonArray.first { it.jsonObject["id"]!!.jsonPrimitive.content == deniedId }.jsonObject["status"]!!.jsonPrimitive.content)
        assertTrue(lane["stickyFacts"]!!.jsonArray.none { it.jsonObject["key"]!!.jsonPrimitive.content == "must_not_exist" })
    }

    @Test
    fun `catalog is readonly and lane tool selections persist only on their board`() = testApplication {
        val temp = Files.createTempDirectory("mcp-api-test")
        val store = WorkspaceStore(temp.resolve("board.sqlite"))
        val root = generateSequence(Path.of("").toAbsolutePath()) { it.parent }
            .first { Files.isRegularFile(it.resolve("examples/mcp/catalog-server.mjs")) }
        val server = McpServerConfig("local-catalog", "Локальный каталог", "демо", "node",
            listOf(root.resolve("examples/mcp/catalog-server.mjs").toString()), root.toString())
        val registry = McpRegistry(listOf(server))
        application { module(store, TestCodex(), OpenRouterHttpGateway(), OpenRouterKeyStore(temp.resolve("key")), registry) }

        val catalogResponse = client.get("/api/mcp/catalog")
        assertEquals(HttpStatusCode.OK, catalogResponse.status)
        val catalogText = catalogResponse.bodyAsText()
        val catalog = Json.parseToJsonElement(catalogText).jsonObject["servers"]!!.jsonArray.single().jsonObject
        assertEquals("connected", catalog["status"]!!.jsonPrimitive.content)
        assertEquals("search_catalog", catalog["tools"]!!.jsonArray.single().jsonObject["name"]!!.jsonPrimitive.content)
        assertFalse(catalogText.contains("catalog-server.mjs"))

        val initial = Json.parseToJsonElement(client.get("/api/board").bodyAsText()).jsonObject
        val firstBoardId = initial["board"]!!.jsonObject["id"]!!.jsonPrimitive.content
        val codexLaneId = initial["lanes"]!!.jsonArray.first().jsonObject["id"]!!.jsonPrimitive.content
        val denied = client.patch("/api/lanes/$codexLaneId/mcp-tools") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"tools":[{"serverId":"local-catalog","toolName":"search_catalog"}]}""")
        }
        assertEquals(HttpStatusCode.BadRequest, denied.status)

        val createdLane = client.post("/api/boards/$firstBoardId/lanes") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"provider":"openrouter"}""")
        }.bodyAsText().let { Json.parseToJsonElement(it).jsonObject["lanes"]!!.jsonArray.last().jsonObject }
        val laneId = createdLane["id"]!!.jsonPrimitive.content
        val saved = client.patch("/api/lanes/$laneId/mcp-tools") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"tools":[{"serverId":"local-catalog","toolName":"search_catalog"}]}""")
        }
        assertEquals(HttpStatusCode.OK, saved.status)
        val savedLane = Json.parseToJsonElement(saved.bodyAsText()).jsonObject["lanes"]!!.jsonArray
            .first { it.jsonObject["id"]!!.jsonPrimitive.content == laneId }.jsonObject
        assertEquals("search_catalog", savedLane["mcpTools"]!!.jsonArray.single().jsonObject["toolName"]!!.jsonPrimitive.content)

        val newBoard = client.post("/api/boards").bodyAsText().let { Json.parseToJsonElement(it).jsonObject }
        val secondBoardId = newBoard["board"]!!.jsonObject["id"]!!.jsonPrimitive.content
        val secondLaneBoard = client.post("/api/boards/$secondBoardId/lanes") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"provider":"openrouter"}""")
        }.bodyAsText().let { Json.parseToJsonElement(it).jsonObject }
        val otherLane = secondLaneBoard["lanes"]!!.jsonArray.last().jsonObject
        assertTrue(otherLane["mcpTools"]!!.jsonArray.isEmpty())
    }
}

private class TestCodex : CodexGateway {
    override suspend fun status() = CodexStatus(false, null)
    override suspend fun models() = JsonArray(emptyList())
    override suspend fun interrupt(threadId: String) = false
    override suspend fun beginLogin() = CodexLogin("https://example.invalid")
    override suspend fun stream(threadId: String?, prompt: String, contextToSeed: List<ContextMessage>, shouldSeedContext: Boolean, model: String,
        onThreadId: suspend (String) -> Unit, onContextSeeded: suspend () -> Unit, onContextSeedFailed: suspend () -> Unit,
        onText: suspend (String) -> Unit, ephemeral: Boolean, onUsage: suspend (kotlinx.serialization.json.JsonObject) -> Unit,
        developerInstructions: String) = Unit
    override fun close() = Unit
}
