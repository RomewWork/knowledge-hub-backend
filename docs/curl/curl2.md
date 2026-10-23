```bash
curl -s -X POST http://localhost:3000/documents/upload/parse \
  -F 'file=@./李先生_28岁_76761.pdf' \
  -F 'authorId=10001' \
  -F 'createBy=10001' | jq
```

```bash
DOC_ID='372103086556057600'
curl -s "http://localhost:3000/documents/${DOC_ID}" | jq
```
