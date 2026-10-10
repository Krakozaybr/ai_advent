package ai.advent.v3

import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.HttpStatusCode
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.application.install
import io.ktor.server.routing.routing
import io.ktor.server.testing.testApplication
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class LocalLlmRoutesTest {
    @Test
    fun `test local status and chat do not require a cloud key`() = testApplication {
        val calls = mutableListOf<String>()
        application {
            install(ContentNegotiation) { json() }
            routing {
                localLlmRoutes { command, input ->
                    calls += command
                    if (command == "request") assertTrue(Json.parseToJsonElement(input).jsonObject.containsKey("question"))
                    buildJsonObject { put("answer", "4"); put("localOnly", true) }
                }
            }
        }
        assertEquals(HttpStatusCode.OK, client.get("/api/local-llm/status").status)
        assertEquals(HttpStatusCode.OK, client.post("/api/local-llm/chat") { setBody("""{"question":"2+2","rag":false}""") }.status)
        assertEquals(listOf("status", "request"), calls)
    }

    @Test
    fun `test invalid input does not launch the local worker`() = testApplication {
        application {
            install(ContentNegotiation) { json() }
            routing { localLlmRoutes { _, _ -> error("Worker must not be called") } }
        }
        for (body in listOf("{}", """{"question":42}""", """{"question":"q","rag":"true"}""", """{"question":"q","rag":{}}""", "invalid-json")) {
            assertEquals(HttpStatusCode.BadRequest, client.post("/api/local-llm/chat") { setBody(body) }.status)
        }
    }

    @Test
    fun `test local errors do not fall back to a cloud provider`() = testApplication {
        application {
            install(ContentNegotiation) { json() }
            routing { localLlmRoutes { _, _ -> error("Ollama unavailable") } }
        }
        assertEquals(HttpStatusCode.ServiceUnavailable, client.post("/api/local-llm/chat") { setBody("""{"question":"q"}""") }.status)
    }
}
