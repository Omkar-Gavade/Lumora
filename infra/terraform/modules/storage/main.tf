# The private bucket holding original uploads (docs/08 §5).
#
# Originals are the one artefact this product cannot regenerate: chunks are
# derived from an original and vectors from chunks, so this bucket is the
# deepest layer of the recovery story. `reindex` re-runs the full ingestion
# pipeline, which reads the original — verified against MinIO — so losing this
# bucket means losing the ability to rebuild vectors at all.

variable "name" { type = string }
variable "environment" { type = string }

resource "aws_s3_bucket" "documents" {
  bucket = var.name

  tags = {
    Application = "lumora"
    Environment = var.environment
  }
}

# Private, and not merely "not public". All four flags, because the default
# for three of them has changed across provider versions and an inherited
# default is not a decision.
resource "aws_s3_bucket_public_access_block" "documents" {
  bucket = aws_s3_bucket.documents.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# The application also requests SSE-S3 per object. This is the bucket-level
# default, so an object written by anything else is still encrypted.
resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Versioning is the recovery mechanism for this layer. A delete or an
# overwrite is recoverable while a version survives, which matters because a
# lost original cannot be rebuilt from anything else in the system.
resource "aws_s3_bucket_versioning" "documents" {
  bucket = aws_s3_bucket.documents.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Noncurrent versions are recovery material, not an archive. Ninety days is
# long enough to notice a mistake and short enough that storage does not grow
# without bound behind a versioning flag nobody looks at.
resource "aws_s3_bucket_lifecycle_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

output "bucket_name" { value = aws_s3_bucket.documents.id }
output "bucket_arn" { value = aws_s3_bucket.documents.arn }
