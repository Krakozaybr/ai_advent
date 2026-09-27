import { createElement } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [rehypeKatex, rehypeHighlight];

export function createMarkdownNode(content) {
  return createElement(ReactMarkdown, { remarkPlugins, rehypePlugins }, content);
}
