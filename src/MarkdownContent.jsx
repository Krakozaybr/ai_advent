import Markdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { normalizeMathDelimiters } from "./markdown.js";

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [rehypeKatex];

export function MarkdownContent({ children }) {
  return (
    <Markdown rehypePlugins={rehypePlugins} remarkPlugins={remarkPlugins}>
      {normalizeMathDelimiters(children)}
    </Markdown>
  );
}
