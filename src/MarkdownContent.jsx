import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

const plugins = [remarkGfm];

export function MarkdownContent({ children }) {
  return <Markdown remarkPlugins={plugins}>{children}</Markdown>;
}
