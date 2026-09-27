package ai.advent.v3

import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.buildJsonObject
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
    private class FakeCodex : CodexGateway {
        override suspend fun status() = CodexStatus(false,null)
        override suspend fun models() = kotlinx.serialization.json.JsonArray(emptyList())
        override suspend fun interrupt(threadId: String) = true
        override suspend fun beginLogin() = CodexLogin("https://example.invalid/login")
        override suspend fun stream(threadId: String?,prompt: String,contextToSeed: List<ContextMessage>,shouldSeedContext: Boolean,model: String,
            onThreadId: suspend (String) -> Unit,onContextSeeded: suspend () -> Unit,onContextSeedFailed: suspend () -> Unit,
            onText: suspend (String) -> Unit,ephemeral: Boolean,onUsage: suspend (kotlinx.serialization.json.JsonObject) -> Unit,developerInstructions: String) {
            error("The scheduler API test does not start Codex runs.")
        }
        override fun close() {}
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
}
