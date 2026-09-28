package ai.advent.v3

import io.ktor.client.request.header
import io.ktor.client.request.delete
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals

class SchedulerApiTest {
    private class FakeClock(var now: Long = System.currentTimeMillis()) : SchedulerClock { override fun nowMillis() = now }
    private class FakeOpenRouter : OpenRouterGateway {
        override suspend fun stream(apiKey: String, config: LaneConfig, history: List<ContextMessage>, prompt: String,
            onText: suspend (String) -> Unit, instructions: String): JsonObject {
            onText("Ответ на: $prompt")
            return buildJsonObject { put("provider", "openrouter") }
        }
        override suspend fun toolRound(apiKey: String, config: LaneConfig, messages: List<JsonObject>, tools: List<JsonObject>,
            onText: suspend (String) -> Unit, instructions: String): OpenRouterToolRound {
            val prompt = messages.last().getValue("content").jsonPrimitive.content
            onText("Ответ на: $prompt")
            return OpenRouterToolRound(buildJsonObject { put("role", "assistant"); put("content", "Ответ на: $prompt") }, buildJsonObject { put("provider", "openrouter") })
        }
        override fun close() = Unit
    }
    private class FakeCodex : CodexGateway {
        override suspend fun status() = CodexStatus(false,null)
        override suspend fun models() = kotlinx.serialization.json.JsonArray(emptyList())
        override suspend fun interrupt(threadId: String) = true
        override suspend fun beginLogin() = CodexLogin("https://example.invalid/login")
        override suspend fun stream(threadId: String?,prompt: String,contextToSeed: List<ContextMessage>,shouldSeedContext: Boolean,model: String,
            onThreadId: suspend (String) -> Unit,onContextSeeded: suspend () -> Unit,onContextSeedFailed: suspend () -> Unit,
            onText: suspend (String) -> Unit,ephemeral: Boolean,onUsage: suspend (kotlinx.serialization.json.JsonObject) -> Unit,developerInstructions: String,
            effort: String?, serviceTier: String?) {
            error("The scheduler API test does not start Codex runs.")
        }
        override fun close() {}
    }

    @Test fun `test schedule history and schedule can be deleted through the API`() = testApplication {
        val directory = Files.createTempDirectory("schedule-delete-api")
        val workspace = WorkspaceStore(directory.resolve("board.sqlite"))
        val boardId = workspace.boards().jsonArray.first().jsonObject["id"]!!.jsonPrimitive.content
        val clock = FakeClock()
        val schedules = SchedulerStore(directory.resolve("schedules.sqlite"), clock)
        val scheduleId = schedules.create(boardId, "cleanup", 250)["id"]!!.jsonPrimitive.content
        clock.now += 250
        assertEquals(1, schedules.tick())
        application {
            module(workspace, FakeCodex(), openRouterKeys = OpenRouterKeyStore(directory.resolve("openrouter.key")),
                mcpRegistry = McpRegistry(emptyList()), memoryStore = MemoryStore(directory.resolve("memory.sqlite")),
                taskStore = TaskStore(directory.resolve("tasks.sqlite")), schedulerStore = schedules)
        }

        val cleared = client.delete("/api/boards/$boardId/schedule-runs")
        assertEquals(HttpStatusCode.OK, cleared.status, cleared.bodyAsText())
        assertEquals("1", kotlinx.serialization.json.Json.parseToJsonElement(cleared.bodyAsText()).jsonObject["deleted"]!!.jsonPrimitive.content)
        assertEquals(0, schedules.runs(boardId)["runs"]!!.jsonArray.size)
        assertEquals(1, schedules.list(boardId)["schedules"]!!.jsonArray.size)

        val removed = client.delete("/api/boards/$boardId/schedules/$scheduleId")
        assertEquals(HttpStatusCode.NoContent, removed.status, removed.bodyAsText())
        assertEquals(0, schedules.list(boardId)["schedules"]!!.jsonArray.size)
        assertEquals(HttpStatusCode.NotFound, client.delete("/api/boards/$boardId/schedules/$scheduleId").status)
        assertEquals(HttpStatusCode.NotFound, client.delete("/api/boards/unknown/schedule-runs").status)
    }

    @Test fun `test scheduled agent reaches OpenRouter lane`() = testApplication {
        val directory = Files.createTempDirectory("schedule-agent-api")
        val workspace = WorkspaceStore(directory.resolve("board.sqlite"))
        val boardId = workspace.boards().jsonArray.first().jsonObject["id"]!!.jsonPrimitive.content
        val laneId = workspace.createLane(boardId, "openrouter")["lanes"]!!.jsonArray.last().jsonObject["id"]!!.jsonPrimitive.content
        val clock = FakeClock()
        val schedules = SchedulerStore(directory.resolve("schedules.sqlite"), clock)
        val keys = OpenRouterKeyStore(directory.resolve("openrouter.key"))
        keys.save("test-key")
        application {
            module(workspace, FakeCodex(), FakeOpenRouter(), keys, McpRegistry(emptyList()),
                memoryStore = MemoryStore(directory.resolve("memory.sqlite")),
                taskStore = TaskStore(directory.resolve("tasks.sqlite")), schedulerStore = schedules)
        }
        val response = client.post("/api/boards/$boardId/schedules") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"title":"Агент","delayMs":250,"agentLaneId":"$laneId","agentPrompt":"Проверь событие"}""")
        }
        assertEquals(HttpStatusCode.Created, response.status, response.bodyAsText())
        clock.now += 300
        for (attempt in 0 until 30) {
            val messages = workspace.board(boardId)["lanes"]!!.jsonArray.last().jsonObject["messages"]!!.jsonArray
            if (schedules.runs(boardId)["runs"]!!.jsonArray.firstOrNull()?.jsonObject?.get("status")?.jsonPrimitive?.content == "completed" &&
                messages.lastOrNull()?.jsonObject?.get("content")?.jsonPrimitive?.content == "Ответ на: Проверь событие") break
            Thread.sleep(100)
        }
        val result = schedules.runs(boardId)["runs"]!!.jsonArray.single().jsonObject["result"]!!.jsonObject
        assertEquals("scheduled-agent", result["source"]!!.jsonPrimitive.content)
        val messages = workspace.board(boardId)["lanes"]!!.jsonArray.last().jsonObject["messages"]!!.jsonArray
        assertEquals("Проверь событие", messages.first().jsonObject["content"]!!.jsonPrimitive.content)
        assertEquals("Ответ на: Проверь событие", messages.last().jsonObject["content"]!!.jsonPrimitive.content)
    }

    @Test fun `approved MCP schedule creation uses trusted lane scope and Ktor close stops its ticker`() {
        val directory = Files.createTempDirectory("schedule-approval-api")
        val workspace = WorkspaceStore(directory.resolve("board.sqlite"))
        val boardId = workspace.boards().jsonArray.first().jsonObject["id"]!!.jsonPrimitive.content
        val laneId = workspace.board(boardId)["lanes"]!!.jsonArray.first().jsonObject["id"]!!.jsonPrimitive.content
        val scheduleDatabase = directory.resolve("schedules.sqlite")
        val clock = FakeClock()
        val schedules = SchedulerStore(scheduleDatabase,clock)
        val approvalId = workspace.addMcpApproval(laneId,"board-schedules","schedule_create",buildJsonObject {
            put("title","Approved schedule"); put("delayMs",60_000); put("repeatEveryMs",2_000); put("reason","User approved the timer")
        },"Create the requested schedule",null)
        val root = Path.of(System.getProperty("user.dir")).toAbsolutePath().parent.parent
        val registry = McpRegistry(listOf(McpServerConfig("board-schedules","Schedules","Current board","node",
            listOf(root.resolve("examples/mcp/board-schedules-server.mjs").toString()),root.toString(),
            mapOf("AI_ADVENT_V3_SCHEDULES_DB" to scheduleDatabase.toString()))))
        testApplication {
            application {
                module(workspace,FakeCodex(),openRouterKeys=OpenRouterKeyStore(directory.resolve("openrouter.key")),
                    mcpRegistry=registry,memoryStore=MemoryStore(directory.resolve("memory.sqlite")),
                    taskStore=TaskStore(directory.resolve("tasks.sqlite")),schedulerStore=schedules)
            }

            val response = client.post("/api/lanes/$laneId/mcp-approvals/$approvalId") {
                header(HttpHeaders.ContentType,ContentType.Application.Json.toString()); setBody("""{"decision":"approve"}""")
            }
            assertEquals(HttpStatusCode.OK,response.status,response.bodyAsText())
            val returnedLane = kotlinx.serialization.json.Json.parseToJsonElement(response.bodyAsText()).jsonObject["lanes"]!!.jsonArray.first().jsonObject
            assertEquals("approved",returnedLane["mcpApprovals"]!!.jsonArray.single().jsonObject["status"]!!.jsonPrimitive.content)
            assertEquals(1,schedules.list(boardId)["schedules"]!!.jsonArray.size)
            assertEquals(0,schedules.list("other-board")["schedules"]!!.jsonArray.size)
        }
        clock.now += 120_000
        Thread.sleep(350)
        assertEquals("active",schedules.list(boardId)["schedules"]!!.jsonArray.single().jsonObject["status"]!!.jsonPrimitive.content)
        assertEquals(0,schedules.runs(boardId)["runs"]!!.jsonArray.size)
        schedules.close()
        workspace.close()
    }

    @Test fun `schedule create rejects object values as bad requests`() = testApplication {
        val directory = Files.createTempDirectory("schedule-validation-api")
        val workspace = WorkspaceStore(directory.resolve("board.sqlite"))
        val boardId = workspace.boards().jsonArray.first().jsonObject["id"]!!.jsonPrimitive.content
        val schedules = SchedulerStore(directory.resolve("schedules.sqlite"),FakeClock())
        application {
            module(workspace,FakeCodex(),openRouterKeys=OpenRouterKeyStore(directory.resolve("openrouter.key")),
                mcpRegistry=McpRegistry(emptyList()),memoryStore=MemoryStore(directory.resolve("memory.sqlite")),
                taskStore=TaskStore(directory.resolve("tasks.sqlite")),schedulerStore=schedules)
        }

        val invalidBodies = listOf(
            """{"title":{"text":"object"},"delayMs":250}""",
            """{"title":"test","delayMs":{"ms":250}}""",
            """{"title":"test","delayMs":250,"repeatEveryMs":{"ms":1000}}""",
        )
        invalidBodies.forEach { body ->
            val response = client.post("/api/boards/$boardId/schedules") {
                header(HttpHeaders.ContentType,ContentType.Application.Json.toString()); setBody(body)
            }
            assertEquals(HttpStatusCode.BadRequest,response.status,"body=$body response=${response.bodyAsText()}")
        }
        val valid = client.post("/api/boards/$boardId/schedules") {
            header(HttpHeaders.ContentType,ContentType.Application.Json.toString()); setBody("""{"title":"valid","delayMs":250,"repeatEveryMs":null}""")
        }
        assertEquals(HttpStatusCode.Created,valid.status,valid.bodyAsText())
        assertEquals(1,schedules.list(boardId)["schedules"]!!.jsonArray.size)
        schedules.close()
        workspace.close()
    }
}
