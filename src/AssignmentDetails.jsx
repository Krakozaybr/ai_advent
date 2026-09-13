import Markdown from "react-markdown";

export function AssignmentDetails({ children }) {
  return (
    <details className="assignment-details">
      <summary>Текст задания</summary>
      <div className="assignment-copy markdown-body">
        <Markdown>{children}</Markdown>
      </div>
    </details>
  );
}
