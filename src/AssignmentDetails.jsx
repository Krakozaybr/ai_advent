import { MarkdownContent } from "./MarkdownContent.jsx";

export function AssignmentDetails({ children }) {
  return (
    <details className="assignment-details">
      <summary>Текст задания</summary>
      <div className="assignment-copy markdown-body">
        <MarkdownContent>{children}</MarkdownContent>
      </div>
    </details>
  );
}
