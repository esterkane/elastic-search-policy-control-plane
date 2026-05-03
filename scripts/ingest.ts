import { readFile } from "node:fs/promises";
import { createElasticsearchClient, productIndex } from "../src/es.js";

type Product = {
  id: string;
  name: string;
  description: string;
  category: string;
  brand: string;
  price: number;
  price_band: string;
  allergens: string[];
  semantic_text_stub: string;
};

const es = createElasticsearchClient();
const products = JSON.parse(await readFile("data/products.json", "utf8")) as Product[];

const exists = await es.indices.exists({ index: productIndex });
if (exists) {
  await es.indices.delete({ index: productIndex });
}

await es.indices.create({
  index: productIndex,
  mappings: {
    properties: {
      name: { type: "text", fields: { keyword: { type: "keyword" } } },
      description: { type: "text" },
      category: { type: "keyword" },
      brand: { type: "keyword" },
      price: { type: "float" },
      price_band: { type: "keyword" },
      allergens: { type: "keyword" },
      semantic_text_stub: { type: "text" }
    }
  }
});

const operations = products.flatMap((product) => [
  { index: { _index: productIndex, _id: product.id } },
  product
]);

const result = await es.bulk({ refresh: true, operations });

if (result.errors) {
  throw new Error("Bulk ingest completed with item-level errors.");
}

console.log(`Ingested ${products.length} products into ${productIndex}.`);
