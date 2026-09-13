export function ResultMetrics({ result }) {
  return (
    <div className="metrics">
      <span>{result.latencyMs} мс</span>
      {result.wordCount != null && <span>{result.wordCount} слов</span>}
      <span>{result.usage?.total_tokens ?? "н/д"} токенов</span>
      <span>{result.cost == null ? "стоимость н/д" : `$${Number(result.cost).toFixed(6)}`}</span>
    </div>
  );
}
