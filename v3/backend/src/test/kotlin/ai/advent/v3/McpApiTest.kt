package ai.advent.v3

import io.ktor.client.request.get
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
        onText: suspend (String) -> Unit, ephemeral: Boolean, onUsage: suspend (kotlinx.serialization.json.JsonObject) -> Unit) = Unit
    override fun close() = Unit
}
