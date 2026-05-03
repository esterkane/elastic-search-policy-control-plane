import { Client } from "@elastic/elasticsearch";

export const PRODUCT_INDEX = "products";

export function createElasticsearchClient(): Client {
  return new Client({
    node: process.env.ELASTICSEARCH_URL ?? "http://localhost:9200"
  });
}
