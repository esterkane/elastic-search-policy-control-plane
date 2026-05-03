import { readFile } from "node:fs/promises";
import path from "node:path";
import { createElasticsearchClient, PRODUCT_INDEX } from "../server/elasticsearch.js";

type Product = {
  id: string;
  name: string;
  description: string;
  category: string;
  price: number;
  allergens: string[];
  tags: string[];
};

const client = createElasticsearchClient();
const dataPath = path.resolve("data", "products.json");
const products = JSON.parse(await readFile(dataPath, "utf8")) as Product[];

const exists = await client.indices.exists({ index: PRODUCT_INDEX });
if (exists) {
  await client.indices.delete({ index: PRODUCT_INDEX });
}

await client.indices.create({
  index: PRODUCT_INDEX,
  mappings: {
    properties: {
      id: { type: "keyword" },
      name: { type: "text" },
      description: { type: "text" },
      category: { type: "keyword" },
      price: { type: "float" },
      allergens: { type: "keyword" },
      tags: { type: "keyword" }
    }
  }
});

const operations = products.flatMap((product) => [
  { index: { _index: PRODUCT_INDEX, _id: product.id } },
  product
]);

const result = await client.bulk({
  refresh: true,
  operations
});

if (result.errors) {
  throw new Error("Bulk ingest completed with item errors.");
}

console.log(`Ingested ${products.length} products into ${PRODUCT_INDEX}.`);
