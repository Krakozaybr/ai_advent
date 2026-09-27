package ai.advent.v3

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class SchedulerMcpTest {
    @Test fun `short lived schedule tools only see the trusted current board`() {
        val root = Path.of(System.getProperty("user.dir")).toAbsolutePath().parent.parent
        val workspace = WorkspaceStore(Files.createTempDirectory("schedule-mcp-board").resolve("board.sqlite"))
        val scheduleDb = Files.createTempDirectory("schedule-mcp-data").resolve("schedules.sqlite")
        try {
            val board = workspace.boards().jsonArray.first().jsonObject
            val boardId = board["id"]!!.jsonPrimitive.content
            val laneId = workspace.board(boardId)["lanes"]!!.jsonArray.first().jsonObject["id"]!!.jsonPrimitive.content
            val scheduleStore = SchedulerStore(scheduleDb)
            val base = McpServerConfig("board-schedules","Расписания","Текущая доска","node",
                listOf(root.resolve("examples/mcp/board-schedules-server.mjs").toString()),root.toString(),
                mapOf("AI_ADVENT_V3_SCHEDULES_DB" to scheduleDb.toString()))
            val server = scopedMcpServer(base,workspace.laneDatabasePath(laneId),laneId,"unused")
            val client = McpClient()
            val tools = client.listTools(server).associateBy { it.name }
            assertTrue(tools.getValue("schedule_create").inputSchema["properties"]!!.jsonObject.keys.none { it == "boardId" })
            assertTrue(!tools.getValue("schedule_create").readOnly)
            assertTrue(tools.getValue("schedules_list").readOnly)
            val created = client.call(server,"schedule_create",buildJsonObject {
                put("title","MCP report"); put("delayMs",250); put("reason","Проверка доски")
            })
            assertTrue(created.toString().contains(boardId))
            val listed = client.call(server,"schedules_list",buildJsonObject {})
            assertTrue(listed.toString().contains("MCP report"))
            assertFailsWith<IllegalArgumentException> {
                client.call(server,"schedule_create",buildJsonObject {
                    put("title","Scope escape"); put("delayMs",250); put("reason","test"); put("boardId","other-board")
                })
            }
            scheduleStore.use { store ->
                assertEquals(1,store.list(boardId)["schedules"]!!.jsonArray.size)
                assertEquals(0,store.list("another-board")["schedules"]!!.jsonArray.size)
            }
        } finally { workspace.close() }
    }
}
