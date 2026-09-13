export function RequestDetails({ request, title = "Технические детали запроса" }) {
  if (!request) {
    return null;
  }

  return (
    <details>
      <summary>{title}</summary>
      <div className="request-details">
        <p className="request-endpoint">
          <strong>{request.method}</strong> <code>{request.url}</code>
        </p>
        <p className="detail-label">Query parameters</p>
        <pre>{JSON.stringify(request.query, null, 2)}</pre>
        <p className="detail-label">JSON body</p>
        <pre>{JSON.stringify(request.json, null, 2)}</pre>
      </div>
    </details>
  );
}
