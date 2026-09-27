package ai.advent.v3

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteReadChannel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class OpenRouterToolsTest {
    @Test
    fun `streaming OpenRouter tool deltas are assembled into one assistant call`() = runBlocking {
        var requestBody = ""
        val http = HttpClient(MockEngine { request ->
            requestBody = (request.body as io.ktor.http.content.TextContent).text
            respond(
                content = ByteReadChannel(
                    listOf(
                        """data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"local__search","arguments":"{\"query\":\""}}]},"finish_reason":null}]}""",
                        """data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"safety\"}"}}]},"finish_reason":"tool_calls"}]}""",
                        "data: [DONE]",
                    ).joinToString("\n\n"),
                ),
                headers = headersOf(HttpHeaders.ContentType, "text/event-stream"),
            )
        })
        val gateway = OpenRouterHttpGateway("https://example.invalid/chat", http)
        try {
            val tool = buildJsonObject {
                put("type", "function")
                put("function", buildJsonObject {
                    put("name", "local__search")
                    put("description", "search")
                    put("parameters", buildJsonObject { put("type", "object") })
                })
            }
            val result = gateway.toolRound("server-secret", LaneConfig("openrouter", "test/model", 0.1, 300, null),
                listOf(buildJsonObject { put("role", "user"); put("content", "find") }), listOf(tool), onText = {})
            val call = result.message["tool_calls"]!!.jsonArray.single().jsonObject
            assertEquals("local__search", call["function"]!!.jsonObject["name"]!!.jsonPrimitive.content)
            assertEquals("{\"query\":\"safety\"}", call["function"]!!.jsonObject["arguments"]!!.jsonPrimitive.content)
            assertTrue(requestBody.contains("\"tool_choice\":\"auto\""))
            assertTrue(requestBody.contains("\"parallel_tool_calls\":false"))
            assertTrue(!requestBody.contains("server-secret"))
        } finally {
            gateway.close()
        }
    }
}
