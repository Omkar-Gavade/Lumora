# Infrastructure as code

**Nothing here has been applied.** No AWS resource exists, no state file exists,
and the credentials on the machine this was written on were invalid
(`InvalidClientTokenId`). Treat every file as a reviewed proposal.

## Why this is deliberately small

docs/09 §10 argues that IaC pays for itself at the *second* environment, and
that a single hand-built production environment is better served by a runbook.
That is still true — this exists so the storage and database resources the
application now genuinely depends on (a private bucket, a Postgres with
pgvector) are described somewhere reviewable, not so that a full ECS topology
is modelled before anyone has decided to pay for one.

Modelled here: **S3** and **RDS**, because the application code now fails to
boot without them in production. Not modelled: VPC, ECS, ALB, CloudFront, ECR,
IAM, Secrets Manager — all of which are named in docs/09 §10 and none of which
the application can tell the difference about until someone deploys.

## Before `terraform apply`

1. Valid AWS credentials for the target account.
2. A decision on region (the machine's config said `ap-south-1`).
3. A remote state backend — S3 with versioning plus a lock table. The local
   backend below is a placeholder and must not be used for a real environment:
   a state file on one laptop is a single point of failure for the whole
   estate.
4. A cost review. §33 of the production brief puts this at roughly $56–88/month
   fixed before usage.
