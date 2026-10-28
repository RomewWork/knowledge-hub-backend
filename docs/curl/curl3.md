---

##  发布文档（直接发布，无审核）

```bash
DOC_ID='docid'
```

将草稿（或已发布文档）设为已发布，并投递 RabbitMQ 异步管线：RAG 向量化。

```bash
curl -s -X PUT "http://localhost:3000/documents/${DOC_ID}/publish"
```

成功后 `status=1`，异步消费会执行：

- **RAG**：Markdown 分块 → Embedding → 写入 Elasticsearch `kh_chunk`（dense_vector）


curl.exe -sS -X PUT http://localhost:8080/documents/373861566107357184/publish`
---

GET /_cat/indices?

GET /kh_document/_search
{
"size": 100,
"query": {
"match_all": {}
}
}

GET /kh_chunk/_search
{
"size": 100,
"query": {
"match_all": {}
}
}

POST /kh_document/_delete_by_query
{
"query": {
"match_all": {}
}
}

POST /kh_chunk/_delete_by_query
{
"query": {
"match_all": {}
}
}
