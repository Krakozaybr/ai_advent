plugins {
    kotlin("jvm") version "2.2.20"
    kotlin("plugin.serialization") version "2.2.20"
    application
}

repositories {
    mavenCentral()
}

dependencies {
    val ktorVersion = "3.3.1"

    implementation("io.ktor:ktor-server-core-jvm:$ktorVersion")
    implementation("io.ktor:ktor-server-netty-jvm:$ktorVersion")
    implementation("io.ktor:ktor-server-sse-jvm:$ktorVersion")
    implementation("io.ktor:ktor-server-content-negotiation-jvm:$ktorVersion")
    implementation("io.ktor:ktor-serialization-kotlinx-json-jvm:$ktorVersion")
    implementation("io.ktor:ktor-client-cio-jvm:$ktorVersion")
    implementation("org.xerial:sqlite-jdbc:3.50.3.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-jdk8:1.10.2")

    testImplementation(kotlin("test"))
    testImplementation("io.ktor:ktor-server-test-host-jvm:$ktorVersion")
    testImplementation("io.ktor:ktor-client-mock-jvm:$ktorVersion")
}

kotlin {
    jvmToolchain(17)
}

application {
    mainClass.set("ai.advent.v3.ApplicationKt")
}

tasks.test {
    useJUnitPlatform()
    reports.html.required.set(false)
    environment("AI_ADVENT_V3_SCHEDULES_DB", layout.buildDirectory.file("test-data/schedules.sqlite").get().asFile.absolutePath)
}

tasks.named<JavaExec>("run") {
    environment(
        "AI_ADVENT_V3_DB",
        System.getenv("AI_ADVENT_V3_DB") ?: rootProject.projectDir.resolve("../data/board.sqlite").absolutePath,
    )
    environment("AI_ADVENT_V3_CWD", rootProject.projectDir.resolve("../..").absolutePath)
    environment("AI_ADVENT_V3_MEMORY_DB", System.getenv("AI_ADVENT_V3_MEMORY_DB") ?: rootProject.projectDir.resolve("../data/memory.sqlite").absolutePath)
    environment("AI_ADVENT_V3_TASKS_DB", System.getenv("AI_ADVENT_V3_TASKS_DB") ?: rootProject.projectDir.resolve("../data/tasks.sqlite").absolutePath)
    environment("AI_ADVENT_V3_SCHEDULES_DB", System.getenv("AI_ADVENT_V3_SCHEDULES_DB") ?: rootProject.projectDir.resolve("../data/schedules.sqlite").absolutePath)
}
