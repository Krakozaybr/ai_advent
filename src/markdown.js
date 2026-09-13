export function normalizeMathDelimiters(markdown = "") {
  return markdown
    .replace(/\\\[/gu, () => "$$")
    .replace(/\\\]/gu, () => "$$")
    .replace(/\\\(/gu, () => "$")
    .replace(/\\\)/gu, () => "$");
}
