# Production environment. NEVER APPLIED — see ../../README.md.

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # PLACEHOLDER. A real environment needs remote state with versioning and
  # locking; a local state file cannot be shared, cannot be recovered, and
  # cannot stop two applies running at once.
  #
  # backend "s3" {
  #   bucket       = "lumora-terraform-state"
  #   key          = "production/terraform.tfstate"
  #   region       = "ap-south-1"
  #   use_lockfile = true
  #   encrypt      = true
  # }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Application = "lumora"
      Environment = "production"
      ManagedBy   = "terraform"
    }
  }
}

variable "region" {
  type    = string
  default = "ap-south-1"
}

# Networking is intentionally not modelled yet (see README). These are the
# inputs a VPC module would supply.
variable "private_subnet_ids" {
  type    = list(string)
  default = []
}

variable "database_security_group_ids" {
  type    = list(string)
  default = []
}

module "storage" {
  source      = "../../modules/storage"
  name        = "lumora-production-documents"
  environment = "production"
}

module "database" {
  source             = "../../modules/database"
  identifier         = "lumora-production"
  environment        = "production"
  subnet_ids         = var.private_subnet_ids
  security_group_ids = var.database_security_group_ids
}

output "documents_bucket" { value = module.storage.bucket_name }
output "database_endpoint" { value = module.database.endpoint }
