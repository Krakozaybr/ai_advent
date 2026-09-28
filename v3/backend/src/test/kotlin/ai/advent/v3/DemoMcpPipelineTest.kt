package ai.advent.v3

import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class DemoMcpPipelineTest {
    @Test
    fun `test demo pipeline passes structured data across servers and uses a generated output path`() = testApplication {
        val temp = Files.createTempDirectory("v3-demo-pipeline")
        val store = WorkspaceStore(temp.resolve("board.sqlite"))
        val boardId = store.boards().first().jsonObject.getValue("id").jsonPrimitive.content
        application { module(store = store, openRouterKeys = OpenRouterKeyStore(temp.resolve("key"))) }

        val response = client.post("/api/boards/$boardId/demo-pipeline") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"query":"MCP"}""")
        }
        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
        val value = Json.parseToJsonElement(response.bodyAsText()).jsonObject
        val steps = value.getValue("steps").jsonArray.map { it.jsonObject }
        assertEquals(listOf("demo-events/search_events", "demo-events/summarize_events", "demo-notes/save_summary"),
            steps.map { "${it.getValue("serverId").jsonPrimitive.content}/${it.getValue("toolName").jsonPrimitive.content}" })
        val searched = steps[0].getValue("result").jsonObject.getValue("structuredContent").jsonObject
        val summarized = steps[1].getValue("result").jsonObject.getValue("structuredContent").jsonObject
        assertEquals(searched.getValue("events"), steps[1].getValue("arguments").jsonObject.getValue("events"))
        assertEquals(summarized, steps[2].getValue("arguments").jsonObject.getValue("summary"))
        assertEquals("1", summarized.getValue("eventCount").jsonPrimitive.content)
        val path = value.getValue("output").jsonObject.getValue("path").jsonPrimitive.content
        assertTrue(path.matches(Regex("v3/data/demo-outputs/[0-9a-f-]{36}\\.json")))
        val root = Path.of(System.getProperty("user.dir")).toAbsolutePath().parent.parent
        val output = root.resolve(path)
        try {
            assertEquals(summarized, Json.parseToJsonElement(Files.readString(output)).jsonObject)
        } finally {
            Files.deleteIfExists(output)
        }
    }

    @Test
    fun `test demo pipeline rejects invalid input and stops after failed search`() = testApplication {
        val temp = Files.createTempDirectory("v3-demo-pipeline-invalid")
        val store = WorkspaceStore(temp.resolve("board.sqlite"))
        val boardId = store.boards().first().jsonObject.getValue("id").jsonPrimitive.content
        application { module(store = store, openRouterKeys = OpenRouterKeyStore(temp.resolve("key"))) }
        suspend fun request(id: String, body: String) = client.post("/api/boards/$id/demo-pipeline") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString()); setBody(body)
        }
        assertEquals(HttpStatusCode.BadRequest, request(boardId, """{"query":3}""").status)
        assertEquals(HttpStatusCode.BadRequest, request(boardId, """{"query":"x","command":"whoami"}""").status)
        assertEquals(HttpStatusCode.BadRequest, request(boardId, """{"query":" "}""").status)
        assertEquals(HttpStatusCode.BadRequest, request(boardId, """{"query":"${"x".repeat(121)}"}""").status)
        assertEquals(HttpStatusCode.NotFound, request("missing-board", """{"query":"MCP"}""").status)
        val outputDirectory = Path.of(System.getProperty("user.dir")).toAbsolutePath().parent.parent.resolve("v3/data/demo-outputs")
        val filesBefore = if (Files.isDirectory(outputDirectory)) Files.list(outputDirectory).use { it.count() } else 0L
        val failed = request(boardId, """{"query":"unmatched-fixture-query"}""")
        assertEquals(HttpStatusCode.UnprocessableEntity, failed.status)
        assertTrue(failed.bodyAsText().contains("не найдено"))
        assertFalse(failed.bodyAsText().contains("/Users/"))
        val filesAfter = if (Files.isDirectory(outputDirectory)) Files.list(outputDirectory).use { it.count() } else 0L
        assertEquals(filesBefore, filesAfter)
    }
}
