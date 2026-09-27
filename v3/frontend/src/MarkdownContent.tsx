import { createMarkdownNode } from "./markdown-renderer.mjs";

export function MarkdownContent({ content }: { content: string }) {
  return <div className="markdown-content">{createMarkdownNode(content)}</div>;
}
