import { parseFragment } from "parse5";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const classicsDirectory = resolve(fileURLToPath(new URL("../../v3/data/rag/classics", import.meta.url)));

const work = (id, title, author, page = `${title} (${author.split(" ").at(-1)})`) => ({ id, title, author, page });
export const classicsWorks = [
  ...[
    ["death", "Смерть чиновника"], ["thick-thin", "Толстый и тонкий"],
    ["chameleon", "Хамелеон"], ["malefactor", "Злоумышленник"],
    ["horse-name", "Лошадиная фамилия"], ["misery", "Тоска"],
    ["vanka", "Ванька"], ["kashtanka", "Каштанка"],
    ["nincompoop", "Размазня"], ["overdoing", "Пересолил"],
    ["burbot", "Налим"], ["surgery", "Хирургия"],
    ["wife", "Супруга"], ["ionych", "Ионыч"],
    ["case", "Человек в футляре"], ["gooseberries", "Крыжовник"],
    ["love", "О любви"], ["grasshopper", "Попрыгунья"],
  ].map(([id, title]) => work(`chekhov-${id}`, title, "Антон Чехов", id === "vanka" ? "Ванька (Чехов, 1886)" : undefined)),
  ...[
    ["shot", "Выстрел"], ["snowstorm", "Метель"],
    ["undertaker", "Гробовщик"], ["stationmaster", "Станционный смотритель"],
    ["lady-peasant", "Барышня-крестьянка"], ["queen-spades", "Пиковая дама"],
  ].map(([id, title]) => work(`pushkin-${id}`, title, "Александр Пушкин")),
  ...[
    ["overcoat", "Шинель"], ["nose", "Нос"],
    ["madman", "Записки сумасшедшего"], ["carriage", "Коляска"],
  ].map(([id, title]) => work(`gogol-${id}`, title, "Николай Гоголь")),
  work("turgenev-mumu", "Муму", "Иван Тургенев"),
  work("turgenev-biryuk", "Бирюк", "Иван Тургенев"),
  work("tolstoy-after-ball", "После бала", "Лев Толстой"),
  work("tolstoy-prisoner", "Кавказский пленник", "Лев Толстой"),
];

const attribute = (node, name) => node.attrs?.find((item) => item.name === name)?.value ?? "";
const blockedTags = new Set(["table", "sup", "script", "style", "figure"]);
const blockedClasses = new Set(["ws-noexport", "noprint", "mw-editsection", "reference", "references", "reflist", "catlinks", "ws-license", "header", "metadata", "notice", "pagenum", "ws-pagenum"]);

function textOf(node) {
  if (node.nodeName === "#text") return node.value;
  if (blockedTags.has(node.tagName) || attribute(node, "class").split(/\s+/).some((name) => blockedClasses.has(name))) return "";
  if (node.tagName === "br") return "\n";
  return (node.childNodes ?? []).map(textOf).join("");
}

export function extractWork(html) {
  const fragment = parseFragment(html);
  const blocks = [];
  let ended = false;
  function visit(node) {
    if (ended) return;
    const classes = attribute(node, "class").split(/\s+/);
    const id = attribute(node, "id");
    if (blockedTags.has(node.tagName) || id === "headertemplate" || id === "toc" || classes.some((name) => blockedClasses.has(name))) return;
    if (/^h[1-6]$/.test(node.tagName ?? "")) {
      const title = textOf(node).replace(/\[править\]/g, "").trim();
      if (/^(Примечания|Ссылки|Источники|Литература|См\. также)$/i.test(title)) { ended = true; return; }
      if (title) blocks.push(`## ${title}`);
      return;
    }
    const inlineDiv = node.tagName === "div" && !(node.childNodes ?? []).some((child) => ["div", "p", "table", "ul", "ol", "h1", "h2", "h3", "h4"].includes(child.tagName));
    if (["p", "center", "pre"].includes(node.tagName) || inlineDiv || classes.includes("poem")) {
      const clone = { ...node, childNodes: (node.childNodes ?? []).filter((child) => !blockedTags.has(child.tagName) && !attribute(child, "class").split(/\s+/).some((name) => blockedClasses.has(name))) };
      const text = textOf(clone).replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
      if (text) blocks.push(text);
      return;
    }
    for (const child of node.childNodes ?? []) visit(child);
  }
  visit(fragment);
  return blocks.join("\n\n").trim();
}

export async function downloadClassics({ directory = classicsDirectory, fetchImpl = fetch, onProgress = console.log } = {}) {
  const corpusDirectory = join(directory, "corpus");
  await mkdir(corpusDirectory, { recursive: true });
  const pagesDirectory = join(directory, "pages");
  await mkdir(pagesDirectory, { recursive: true });
  const documents = [];
  async function pageText(page) {
    const cacheFile = join(pagesDirectory, `${createHash("sha256").update(page).digest("hex")}.json`);
    try { return JSON.parse(await readFile(cacheFile, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const url = new URL("https://ru.wikisource.org/w/api.php");
    url.search = new URLSearchParams({ action: "parse", format: "json", page, prop: "text|revid|links", redirects: "1" });
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((done) => setTimeout(done, attempt ? 30_000 : 4500));
      const response = await fetchImpl(url, { headers: { "User-Agent": "AI-Advent-Classics/1.0 (educational corpus)" }, signal: AbortSignal.timeout(30_000) });
      const body = await response.text();
      if (response.status === 429 || /too many requests/i.test(body)) continue;
      if (!response.ok) throw new Error(`${page}: Викитека HTTP ${response.status}`);
      const value = JSON.parse(body);
      if (!value.parse?.text?.["*"]) throw new Error(`${page}: ${value.error?.info ?? "нет текста"}`);
      await writeFile(cacheFile, JSON.stringify(value.parse), "utf8");
      return value.parse;
    }
    throw new Error(`${page}: Викитека ограничила частоту запросов; повторите загрузку позже.`);
  }
  for (const item of classicsWorks) {
    let page = await pageText(item.page);
    let text = extractWork(page.text["*"]);
    const parts = [];
    if (text.split(/\s+/u).length < 250) {
      const edition = (page.links ?? []).filter((link) => link.ns === 0 && link["*"].startsWith(`${page.title}/`) && /ПСС|ВТ/.test(link["*"]) && !/ДО|ударени/.test(link["*"]))
        .sort((left, right) => Number(/1975/.test(right["*"])) - Number(/1975/.test(left["*"])))[0];
      if (edition) { page = await pageText(edition["*"]); text = extractWork(page.text["*"]); }
    }
    if (text.split(/\s+/u).length < 250) {
      const chapters = (page.links ?? []).filter((link) => link.ns === 0 && link["*"].startsWith(`${page.title}/`) && /^(?:Глава\s+[IVXLC\d]+|[IVXLC]+|\d+)$/u.test(link["*"].slice(page.title.length + 1)));
      const chapterTexts = [];
      for (const chapter of chapters) {
        const child = await pageText(chapter["*"]);
        const chapterText = extractWork(child.text["*"]);
        if (chapterText.length < 100) throw new Error(`${child.title}: глава пуста.`);
        const section = child.title.slice(page.title.length + 1);
        chapterTexts.push(`## ${section}\n\n${chapterText}`);
        parts.push({ page: child.title, revision_id: child.revid });
      }
      if (chapterTexts.length) text = chapterTexts.join("\n\n");
    }
    const wordCount = text.split(/\s+/u).filter(Boolean).length;
    if (wordCount < 250) throw new Error(`${item.title}: найдено только ${wordCount} слов; проверьте страницу.`);
    const file = `${item.id}.md`;
    const content = `# ${item.title}\n\n${text}\n`;
    await writeFile(join(corpusDirectory, file), content, "utf8");
    documents.push({ ...item, resolvedPage: page.title, parts, file, source: `classics/${file}`, source_url: `https://ru.wikisource.org/wiki/${encodeURIComponent(page.title.replaceAll(" ", "_"))}`, revision_id: page.revid, wordCount, sha256: createHash("sha256").update(content).digest("hex"), license: "Public-domain original; Wikisource text attribution: CC BY-SA 4.0" });
    onProgress(`${documents.length}/${classicsWorks.length}: ${item.author} — ${item.title}: ${wordCount} слов`);
  }
  const manifest = { version: 1, downloadedAt: new Date().toISOString(), documents };
  await writeFile(join(corpusDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export async function loadClassics(directory = classicsDirectory) {
  const corpusDirectory = join(directory, "corpus");
  const manifest = JSON.parse(await readFile(join(corpusDirectory, "manifest.json"), "utf8"));
  if (manifest.version !== 1 || manifest.documents.length < 30) throw new Error("Корпус классики должен содержать минимум 30 произведений.");
  return Promise.all(manifest.documents.map(async ({ file, ...metadata }) => {
    if (!/^[a-z0-9-]+\.md$/.test(file)) throw new Error("Некорректное имя файла в корпусе.");
    const text = await readFile(join(corpusDirectory, file), "utf8");
    if (createHash("sha256").update(text).digest("hex") !== metadata.sha256) throw new Error(`Текст ${file} изменён; обновите manifest.`);
    return { ...metadata, text: text.trim() };
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await downloadClassics();
  console.log(`Готово: ${manifest.documents.length} произведений, ${manifest.documents.reduce((sum, item) => sum + item.wordCount, 0)} слов.`);
}
