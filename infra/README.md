# Optional infrastructure

The root `Dockerfile.api`, `Dockerfile.runner`, `cloudbuild-api.yaml`,
`cloudbuild-runner.yaml`, `firebase.json`, and `firestore.rules` are deployment
templates kept at their current paths so existing commands do not break.

They are optional. Local research and the five-minute demo require none of
them. Any deployment must use the operator's own Firebase/GCP project,
artifact registry, bucket, Cloud Run service, and allowed origins. No hosted
Botwiner project is configured by default.

Before deploying, set the environment values documented in `.env.example`,
review the Cloud Run service ID and region in `firebase.json`, apply the
Firestore rules to the intended project, and verify that no credentials are
present in build arguments or source files.
