const response = await fetch("https://openrouter.ai/api/v1/models");
const data = await response.json();

if (!response.ok) {
  throw new Error(data.error?.message || `HTTP ${response.status}`);
}

for (const model of data.data) {
  console.log(`${model.id}\t${model.name}\tinput=${model.pricing?.prompt}\toutput=${model.pricing?.completion}`);
}
