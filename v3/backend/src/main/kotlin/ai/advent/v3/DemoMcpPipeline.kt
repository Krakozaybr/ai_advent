package ai.advent.v3

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

class DemoEventsNotFoundException : RuntimeException()

/** Executes only the fixed, server-owned demo tools. No request field selects a command or path. */
class DemoMcpPipeline(
    private val client: McpClient,
    servers: List<McpServerConfig> = McpRegistry.demoServers(),
) {
    private val eventsServer = servers.single { it.id == "demo-events" }
    private val notesServer = servers.single { it.id == "demo-notes" }

    fun run(query: String): JsonObject {
        require(query.isNotBlank() && query.length <= 120) { "Длина query должна быть от 1 до 120 символов." }
        val steps = mutableListOf<JsonObject>()
        fun execute(server: McpServerConfig, name: String, arguments: JsonObject): JsonObject {
            val result = client.call(server, name, arguments)
            steps += buildJsonObject {
                put("serverId", server.id)
                put("toolName", name)
                put("arguments", arguments)
                put("result", result)
            }
            return result["structuredContent"]?.jsonObject ?: error("MCP tool returned no structuredContent.")
        }

        val found = execute(eventsServer, "search_events", buildJsonObject { put("query", query) })
        val events = found["events"] as? JsonArray ?: error("search_events returned no events array.")
        if (events.isEmpty()) throw DemoEventsNotFoundException()
        val summarized = execute(eventsServer, "summarize_events", buildJsonObject { put("events", events) })
        val saved = execute(notesServer, "save_summary", buildJsonObject { put("summary", summarized) })
        return buildJsonObject { put("steps", JsonArray(steps)); put("output", saved) }
    }
}
