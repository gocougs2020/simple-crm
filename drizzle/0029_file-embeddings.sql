CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "embedding" vector(1536);--> statement-breakpoint
CREATE INDEX "files_embedding_idx" ON "files" USING hnsw ("embedding" vector_cosine_ops);