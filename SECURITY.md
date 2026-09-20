# Security policy

This repository is a research project. Do not commit API keys, service-account
files, wallet keys, provider URLs containing credentials, or local `.env`
files. The dashboard reads Firebase client configuration from local
`VITE_FIREBASE_*` environment variables, so no operator's project or hosted
dashboard is bundled in the source tree. Access control is enforced by each
operator's Firestore rules and API authorization settings; client configuration
is not a service-account credential.

If you find a credential or a security issue, do not publish it in an issue.
Contact the repository owner privately and include the affected commit or file
path. Any credential that may have been exposed should be revoked and rotated
before the history is rewritten.
