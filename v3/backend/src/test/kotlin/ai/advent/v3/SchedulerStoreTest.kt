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
import kotlin.test.assertFailsWith

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
        SchedulerStore(file,clock).use { reopened ->
            assertEquals("completed",reopened.list("board")["schedules"]!!.jsonArray.single().jsonObject["status"]!!.jsonPrimitive.content)
            assertEquals(1,reopened.runs("board")["runs"]!!.jsonArray.size)
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
        SchedulerStore(file,clock).use { reopened ->
            assertEquals(16_000L,reopened.list("board")["schedules"]!!.jsonArray.single().jsonObject["nextRunAt"]!!.jsonPrimitive.content.toLong())
            assertEquals(1,reopened.runs("board")["runs"]!!.jsonArray.size)
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
        val store = SchedulerStore(file,clock)
        store.create("board","parallel",250)
        clock.now += 1000
        val gate = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)
        try {
            val a = pool.submit<Int> { gate.await(); store.tick() }
            val b = pool.submit<Int> { gate.await(); store.tick() }
            gate.countDown()
            assertEquals(1,a.get()+b.get())
            assertEquals(1,store.runs("board")["runs"]!!.jsonArray.size)
        } finally { pool.shutdownNow(); store.close() }
    }

    @Test fun `second backend cannot recover a run while its owner is alive`() {
        val file = Files.createTempDirectory("scheduler-owner").resolve("schedule.sqlite")
        val clock = FakeClock()
        val owner = SchedulerStore(file,clock)
        try {
            val scheduleId = owner.create("board","periodic in progress",1000,1000)["id"]!!.jsonPrimitive.content
            val slot = clock.now + 1000
            DriverManager.getConnection("jdbc:sqlite:$file").use { db ->
                db.createStatement().use { it.executeUpdate("UPDATE schedules SET next_run_at=${slot + 1000} WHERE id='$scheduleId'") }
                db.createStatement().use { it.executeUpdate("INSERT INTO schedule_runs(id,schedule_id,board_id,scheduled_for,started_at,status,missed_count) SELECT 'owner-run',id,board_id,$slot,$slot,'running',0 FROM schedules WHERE id='$scheduleId'") }
            }
            clock.now += 5000
            assertFailsWith<SchedulerAlreadyRunningException> { SchedulerStore(file,clock) }
            DriverManager.getConnection("jdbc:sqlite:$file").use { db ->
                db.createStatement().use { statement -> statement.executeQuery("SELECT status FROM schedule_runs WHERE id='owner-run'").use { rs ->
                    assertEquals("running",rs.singleString())
                } }
                db.createStatement().use { statement -> statement.executeQuery("SELECT next_run_at FROM schedules WHERE id='$scheduleId'").use { rs ->
                    assertEquals(slot + 1000,rs.singleLong())
                } }
            }
        } finally { owner.close() }

        SchedulerStore(file,clock).use { recovered ->
            assertEquals(1,recovered.tick())
            assertEquals("completed",recovered.runs("board")["runs"]!!.jsonArray.single().jsonObject["status"]!!.jsonPrimitive.content)
            assertEquals(clock.now + 1000,recovered.list("board")["schedules"]!!.jsonArray.single().jsonObject["nextRunAt"]!!.jsonPrimitive.content.toLong())
        }
    }

    private fun java.sql.ResultSet.singleString(): String { check(next()); return getString(1) }
    private fun java.sql.ResultSet.singleLong(): Long { check(next()); return getLong(1) }
}
