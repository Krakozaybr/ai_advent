package ai.advent.v3

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import java.nio.file.Path

class McpTest {
    @Test
    fun `local stdio MCP server initializes lists and executes the catalog tool`() {
        val root = Path.of(System.getProperty("user.dir")).toAbsolutePath().parent.parent
        val server = McpServerConfig("local-catalog", "Catalog", "test", "node",
            listOf(root.resolve("examples/mcp/catalog-server.mjs").toString()), root.toString())
        val client = McpClient()
        val tools = client.listTools(server)
        assertEquals(listOf("search_catalog"), tools.map { it.name })
        assertEquals("string", tools.single().inputSchema["properties"]!!.jsonObject["query"]!!.jsonObject["type"]!!.jsonPrimitive.content)
        val result = client.call(server, "search_catalog", buildJsonObject { put("query", "safety") })
        assertEquals("1", result["structuredContent"]!!.jsonObject["count"]!!.jsonPrimitive.content)
        assertFailsWith<IllegalArgumentException> { client.call(server, "search_catalog", buildJsonObject { put("other", "safety") }) }
        assertFailsWith<IllegalStateException> { client.call(server, "missing", buildJsonObject {}) }
    }

    @Test
    fun `stdio timeout and protocol errors are surfaced`() {
        val cwd = System.getProperty("user.dir")
        val timeoutServer = McpServerConfig("slow", "slow", "", "node", listOf("-e", "process.stdin.resume()"), cwd)
        assertTrue(assertFailsWith<IllegalStateException> { McpClient(100).listTools(timeoutServer) }.message!!.contains("timed out"))

        val errorProgram = """
            import { createInterface } from 'node:readline';
            for await (const line of createInterface({input:process.stdin})) {
              const r = JSON.parse(line);
              if (r.method === 'initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{protocolVersion:'2025-03-26',capabilities:{},serverInfo:{name:'bad',version:'1'}}}));
              if (r.method === 'tools/list') console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code:-1,message:'catalog unavailable'}}));
            }
        """.trimIndent()
        val errorServer = McpServerConfig("broken", "broken", "", "node", listOf("--input-type=module", "-e", errorProgram), cwd)
        assertTrue(assertFailsWith<IllegalStateException> { McpClient().listTools(errorServer) }.message!!.contains("catalog unavailable"))
    }

    @Test
    fun `unsupported schema constraints are rejected instead of ignored`() {
        val patternSchema = kotlinx.serialization.json.Json.parseToJsonElement("""{"type":"object","properties":{"key":{"type":"string","pattern":"^[a-z]+$"}}}""").jsonObject
        val oneOfSchema = kotlinx.serialization.json.Json.parseToJsonElement("""{"type":"object","oneOf":[{"required":["a"]},{"required":["b"]}]}""").jsonObject
        assertTrue(assertFailsWith<IllegalArgumentException> { McpClient.validateSchema(buildJsonObject { put("key", "valid") }, patternSchema) }.message!!.contains("unsupported"))
        assertTrue(assertFailsWith<IllegalArgumentException> { McpClient.validateSchema(buildJsonObject {}, oneOfSchema) }.message!!.contains("unsupported"))
    }
}
