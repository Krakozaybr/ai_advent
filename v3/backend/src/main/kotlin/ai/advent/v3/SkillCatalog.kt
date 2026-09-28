package ai.advent.v3

data class SessionSkill(val id: String, val name: String, val description: String, val instructions: String)

object SkillCatalog {
    val all = listOf(
        SessionSkill(
            "files",
            "Работа с файлами",
            "Проверяй доступные файлы и показывай точные пути и изменения.",
            "При работе с файлами сначала выясни, какие источники и операции доступны. Не утверждай, что прочитал или изменил файл, если инструмент этого не подтвердил. Для правок называй точные файлы и кратко описывай результат.",
        ),
        SessionSkill(
            "planning",
            "Планирование",
            "Разбивай цель на проверяемые шаги и отмечай зависимости.",
            "Для многошаговой задачи сначала сформулируй ближайший проверяемый результат, затем перечисли короткие шаги и зависимости. Обновляй план при изменении фактов и отмечай завершённые шаги.",
        ),
        SessionSkill(
            "web-search",
            "Поиск в сети",
            "Используй только реально подключённый поиск и указывай источники.",
            "Если доступен поисковый инструмент, проверяй через него актуальные или неуверенные сведения и связывай выводы с источниками. Если поиск недоступен, явно скажи об этом; не выдумывай результаты и ссылки.",
        ),
    )

    private val byId = all.associateBy(SessionSkill::id)

    fun validate(ids: List<String>): List<String> {
        require(ids.size <= all.size && ids.distinct().size == ids.size && ids.all(byId::containsKey)) {
            "Выбраны неизвестные навыки сессии."
        }
        return ids
    }

    fun instructions(ids: List<String>): String = validate(ids).mapNotNull(byId::get)
        .joinToString("\n\n") { "Навык «${it.name}»:\n${it.instructions}" }
}
