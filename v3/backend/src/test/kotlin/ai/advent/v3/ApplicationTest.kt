package ai.advent.v3

import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import java.nio.file.Files

class ApplicationTest {
    @Test
    fun `test streamed answer is saved and restored with the Codex session`() = testApplication {
        val database = Files.createTempDirectory("ai-advent-v3-").resolve("board.sqlite")
        val store = BoardStore(database)
        val fake = FakeCodexAppServer()
        application { module(store, fake) }

        val initialBoard = client.get("/api/board").bodyAsText().let { Json.parseToJsonElement(it).jsonObject }
        val lane = initialBoard["lanes"]!!.jsonArray[0].jsonObject
        val laneId = lane["id"]!!.jsonPrimitive.content
        val response = client.post("/api/lanes/$laneId/messages") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"text":"Привет"}""")
        }
        assertEquals(HttpStatusCode.Accepted, response.status)
        val runId = response.bodyAsText().let { Json.parseToJsonElement(it).jsonObject }
            .getValue("runId").jsonPrimitive.content
        fake.finished.await()

        val stream = client.get("/api/runs/$runId/events").bodyAsText()
        assertTrue(stream.contains("\"type\":\"text.delta\""))
        assertTrue(stream.contains("Привет, "))
        assertTrue(stream.contains("мир"))
        assertTrue(stream.contains("\"type\":\"run.completed\""))

        val finalBoard = client.get("/api/board").bodyAsText().let { Json.parseToJsonElement(it).jsonObject }
        val messages = finalBoard["lanes"]!!.jsonArray[0].jsonObject["messages"]!!.jsonArray
        assertEquals("Привет, мир", messages.last().jsonObject["content"]!!.jsonPrimitive.content)

        val restored = BoardStore(database)
        val restoredLane = restored.board()["lanes"]!!.jsonArray[0].jsonObject
        assertEquals("fake-codex-thread", restoredLane["codexThreadId"]!!.jsonPrimitive.content)
        assertEquals(messages.size, restoredLane["messages"]!!.jsonArray.size)
        restored.close()
    }

    @Test
    fun `test a lane rejects a second active request`() = testApplication {
        val database = Files.createTempDirectory("ai-advent-v3-").resolve("board.sqlite")
        val store = BoardStore(database)
        val fake = FakeCodexAppServer(blockUntilReleased = true)
        application { module(store, fake) }
        val board = client.get("/api/board").bodyAsText().let { Json.parseToJsonElement(it).jsonObject }
        val laneId = board["lanes"]!!.jsonArray[0].jsonObject["id"]!!.jsonPrimitive.content

        val first = client.post("/api/lanes/$laneId/messages") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"text":"Первый запрос"}""")
        }
        assertEquals(HttpStatusCode.Accepted, first.status)
        fake.started.await()
        val second = client.post("/api/lanes/$laneId/messages") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"text":"Второй запрос"}""")
        }
        assertEquals(HttpStatusCode.Conflict, second.status)

        fake.release.complete(Unit)
        fake.finished.await()
    }

    @Test
    fun `test failed app-server turn stays a failed run`() = testApplication {
        val database = Files.createTempDirectory("ai-advent-v3-").resolve("board.sqlite")
        val store = BoardStore(database)
        val fake = FakeCodexAppServer(failTurn = true)
        application { module(store, fake) }
        val board = client.get("/api/board").bodyAsText().let(Json::parseToJsonElement).jsonObject
        val laneId = board["lanes"]!!.jsonArray[0].jsonObject["id"]!!.jsonPrimitive.content
        val response = client.post("/api/lanes/$laneId/messages") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"text":"Ошибка"}""")
        }
        val runId = response.bodyAsText().let { Json.parseToJsonElement(it).jsonObject }
            .getValue("runId").jsonPrimitive.content
        fake.finished.await()
        val stream = client.get("/api/runs/$runId/events").bodyAsText()

        assertTrue(stream.contains("\"type\":\"run.failed\""))
        assertFalse(stream.contains("\"type\":\"run.completed\""))
    }
}

private class FakeCodexAppServer(
    private val blockUntilReleased: Boolean = false,
    private val failTurn: Boolean = false,
) : CodexGateway {
    val started = CompletableDeferred<Unit>()
    val release = CompletableDeferred<Unit>()
    val finished = CompletableDeferred<Unit>()

    override suspend fun status() = CodexStatus(authenticated = true, planType = "pro")

    override suspend fun beginLogin() = CodexLogin("https://example.invalid/login")

    override suspend fun stream(
        threadId: String?,
        prompt: String,
        onThreadId: suspend (String) -> Unit,
        onText: suspend (String) -> Unit,
    ) {
        onThreadId(threadId ?: "fake-codex-thread")
        started.complete(Unit)
        try {
            if (blockUntilReleased) release.await()
            if (failTurn) error("Fake Codex failure")
            onText("Привет, ")
            delay(20)
            onText("мир")
        } finally {
            finished.complete(Unit)
        }
    }

    override fun close() = Unit
}
