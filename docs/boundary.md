# Boundary

Schift AI Memory is a distribution/client repo.

It may contain:

- installer CLI code
- local queue and uploader client code
- MCP server components
- Codex plugin manifests
- Claude Code hook installers
- Claude Desktop MCPB bundle templates
- tests and smoke scripts for those client surfaces

It must not contain:

- Schift Agent Hub runtime services
- bucket routing implementation
- RAG indexing workers
- production auth exchange internals
- Cloud Run or Terraform deploy scripts
- company-private data, fixtures, or transcripts

The Schift monorepo owns server ingest, authorization, company bucket routing,
RAG indexing, audit evidence, and hosted MCP deployment.

The client-side scope contract for the server is documented in
`docs/server-scope-enforcement.md`. This repo may define the contract and smoke
tests, but the server implementation must live with the auth/bucket API service.
