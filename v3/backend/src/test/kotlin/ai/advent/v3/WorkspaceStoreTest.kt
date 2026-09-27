package ai.advent.v3

import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals

class WorkspaceStoreTest {
    @Test
    fun `board order follows creation time across imports new boards and restart`() {
        val directory = Files.createTempDirectory("workspace-board-order-")
        val database = directory.resolve("board.sqlite")
        val store = WorkspaceStore(database)
        val expectedIds = mutableListOf(store.boards().first().jsonObject["id"]!!.jsonPrimitive.content)

        listOf("Импорт 1", "Импорт 2", "Импорт 3").forEachIndexed { index, title ->
            Thread.sleep(10)
            val imported = store.importPreparedBoard(
                ImportedBoard("external-$index", title, "", emptyList(), emptyList()),
            ).first
            expectedIds += imported["board"]!!.jsonObject["id"]!!.jsonPrimitive.content
        }

        Thread.sleep(10)
        val created = store.createBoard()
        expectedIds += created["board"]!!.jsonObject["id"]!!.jsonPrimitive.content
        assertEquals(expectedIds, store.boards().map { it.jsonObject["id"]!!.jsonPrimitive.content })
        store.close()

        val reopened = WorkspaceStore(database)
        assertEquals(expectedIds, reopened.boards().map { it.jsonObject["id"]!!.jsonPrimitive.content })
        assertEquals(
            listOf("Доска 1", "Импорт 1", "Импорт 2", "Импорт 3", "Доска 5"),
            reopened.boards().map { it.jsonObject["title"]!!.jsonPrimitive.content },
        )
        reopened.close()
    }

    @Test
    fun `board order uses board id as a stable tie breaker`() {
        val directory = Files.createTempDirectory("workspace-board-order-tie-")
        val database = directory.resolve("board.sqlite")
        val store = WorkspaceStore(database)
        val primaryId = store.boards().first().jsonObject["id"]!!.jsonPrimitive.content
        repeat(3) { index ->
            store.importPreparedBoard(ImportedBoard("external-$index", "Импорт $index", "", emptyList(), emptyList()))
        }
        store.close()

        Files.list(directory.resolve("boards")).use { paths ->
            paths.filter { it.fileName.toString().endsWith(".sqlite") }.forEach { path ->
                java.sql.DriverManager.getConnection("jdbc:sqlite:$path").use { connection ->
                    connection.prepareStatement("UPDATE boards SET created_at = ?").use { statement ->
                        statement.setString(1, "2026-01-01T00:00:00Z")
                        statement.executeUpdate()
                    }
                }
            }
        }

        val reopened = WorkspaceStore(database)
        val orderedIds = reopened.boards().map { it.jsonObject["id"]!!.jsonPrimitive.content }
        assertEquals(primaryId, orderedIds.first())
        assertEquals(orderedIds.drop(1).sorted(), orderedIds.drop(1))
        reopened.close()
    }
}
