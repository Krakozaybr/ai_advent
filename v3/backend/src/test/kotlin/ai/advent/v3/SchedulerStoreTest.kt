package ai.advent.v3

import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.nio.file.Files
import java.sql.DriverManager
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class SchedulerStoreTest {
    private class FakeClock(var now: Long = 10_000) : SchedulerClock { override fun nowMillis() = now }

    @Test fun `overdue one shot runs once and stores local aggregate`() {
        val file = Files.createTempDirectory("scheduler-once").resolve("schedule.sqlite")
        val clock = FakeClock()
        SchedulerStore(file,clock).use { store ->
            store.create("board","one shot",250)
            clock.now += 30_000
            assertEquals(1,store.tick())
            assertEquals(0,store.tick())
            val schedule = store.list("board")["schedules"]!!.jsonArray.single().jsonObject
            assertEquals("completed",schedule["status"]!!.jsonPrimitive.content)
            val run = store.runs("board")["runs"]!!.jsonArray.single().jsonObject
            assertEquals("completed",run["status"]!!.jsonPrimitive.content)
            val result = run["result"]!!.jsonObject
            assertEquals("116",result["total"]!!.jsonPrimitive.content)
            assertEquals("16.57",result["average"]!!.jsonPrimitive.content)
        }
    }

    @Test fun `missed periodic slots collapse into one run`() {
        val file = Files.createTempDirectory("scheduler-periodic").resolve("schedule.sqlite")
        val clock = FakeClock()
        SchedulerStore(file,clock).use { store ->
            store.create("board","periodic",1000,1000)
            clock.now += 5100
            assertEquals(1,store.tick())
            val run = store.runs("board")["runs"]!!.jsonArray.single().jsonObject
            assertEquals("4",run["missedCount"]!!.jsonPrimitive.content)
            assertEquals(16_000L,store.list("board")["schedules"]!!.jsonArray.single().jsonObject["nextRunAt"]!!.jsonPrimitive.content.toLong())
        }
    }

    @Test fun `reopening recovers interrupted one shot`() {
        val file = Files.createTempDirectory("scheduler-reopen").resolve("schedule.sqlite")
        val clock = FakeClock()
        val scheduleId = SchedulerStore(file,clock).use { store ->
            val created = store.create("board","recover",250)
            val id = created["id"]!!.jsonPrimitive.content
            store.pause("board",id,true)
            id
        }
        val slot = 10_250L
        DriverManager.getConnection("jdbc:sqlite:$file").use { db ->
            db.createStatement().use { it.executeUpdate("UPDATE schedules SET next_run_at=$slot WHERE id='$scheduleId'") }
            db.createStatement().use { it.executeUpdate("INSERT INTO schedule_runs(id,schedule_id,board_id,scheduled_for,started_at,status,missed_count) SELECT 'interrupted-run',id,board_id,$slot,$slot,'running',0 FROM schedules WHERE id='$scheduleId'") }
        }
        clock.now += 5000
        SchedulerStore(file,clock).use { recovered ->
            assertEquals(0,recovered.tick(),"Restart recovery must respect a user's pause")
            recovered.pause("board",scheduleId,false)
            assertEquals(1,recovered.tick())
            val run = recovered.runs("board")["runs"]!!.jsonArray.single().jsonObject
            assertEquals("completed",run["status"]!!.jsonPrimitive.content)
            assertNotNull(run["result"])
            assertEquals(1,recovered.runs("board")["runs"]!!.jsonArray.size)
        }
    }

    @Test fun `parallel workers atomically claim a due run once`() {
        val file = Files.createTempDirectory("scheduler-parallel").resolve("schedule.sqlite")
        val clock = FakeClock()
        SchedulerStore(file,clock).use { it.create("board","parallel",250) }
        clock.now += 1000
        val first = SchedulerStore(file,clock)
        val second = SchedulerStore(file,clock)
        val gate = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)
        try {
            val a = pool.submit<Int> { gate.await(); first.tick() }
            val b = pool.submit<Int> { gate.await(); second.tick() }
            gate.countDown()
            assertEquals(1,a.get()+b.get())
            assertEquals(1,first.runs("board")["runs"]!!.jsonArray.size)
        } finally { pool.shutdownNow(); first.close(); second.close() }
    }
}
