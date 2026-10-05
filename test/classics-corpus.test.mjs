import test from "node:test";
import assert from "node:assert/strict";
import { extractWork, classicsWorks } from "../examples/ai-advent/classics-corpus.mjs";
import { chunkDocuments } from "../examples/ai-advent/rag.mjs";

test("литературный текст извлекается без навигации, сносок и примечаний", () => {
  const html = `<div class="mw-parser-output">
    <div id="headertemplate"><p>Меню произведения</p></div>
    <table><tr><td>Правовое уведомление</td></tr></table>
    <h2>Глава I</h2><p>Первая фраза<span><sup class="reference">[1]</sup></span>.</p>
    <p>Вторая фраза.<br>Продолжение.</p>
    <center><i>На деревню дедушке.</i></center>
    <div class="mw-heading"><h2>Примечания</h2></div><p>Редакторский комментарий.</p>
  </div>`;
  assert.equal(extractWork(html), "## Глава I\n\nПервая фраза.\n\nВторая фраза.\nПродолжение.\n\nНа деревню дедушке.");
});

test("32 произведения имеют уникальные идентификаторы, чанки сохраняют автора и публичный источник", () => {
  assert.equal(classicsWorks.length, 32);
  assert.equal(new Set(classicsWorks.map((item) => item.id)).size, 32);
  const doc = { id: "example", source: "classics/example.md", title: "Повесть", author: "Автор", source_url: "https://ru.wikisource.org/wiki/Example", revision_id: 123, text: "# Повесть\n\n## Глава I\n\nПервый абзац.\n\n## Глава II\n\nВторой абзац." };
  const chunks = chunkDocuments([doc], "structural");
  assert.ok(chunks.some((chunk) => chunk.section === "Глава II"));
  assert.ok(chunks.every((chunk) => chunk.author === "Автор" && chunk.source_url === doc.source_url && chunk.revision_id === 123));
});
