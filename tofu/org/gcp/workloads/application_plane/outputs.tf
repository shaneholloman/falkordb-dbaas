output "cloud_artifact_registry_reader_service_account_email" {
  value = google_service_account.cloud_artifact_registry_reader.email
}

output "cloud_artifact_registry_reader_service_account_json_key" {
  value     = google_service_account_key.cloud_artifact_registry_reader.private_key
  sensitive = true
}

output "cloud_artifact_registry_host" {
  value = "${google_artifact_registry_repository.cloud.location}-docker.pkg.dev"
}

output "cloud_artifact_registry_writer_service_account_email" {
  value = google_service_account.cloud_artifact_registry_writer.email
}

output "cloud_artifact_registry_writer_workload_identity_provider" {
  value = module.cloud_artifact_registry_writer_gh_oidc.provider_name
}

output "cloud_artifact_registry_writer_workload_identity_pool_name" {
  value = module.cloud_artifact_registry_writer_gh_oidc.pool_name
}