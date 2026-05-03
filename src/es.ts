import { Client } from "@elastic/elasticsearch";

export const productIndex = "products";

export function createElasticsearchClient(): Client {
  return new Client({
    node: process.env.ELASTICSEARCH_URL ?? "http://localhost:9200"
  });
}
