# Security policy

This repository is a research project. Do not commit API keys, service-account
files, wallet keys, provider URLs containing credentials, or local `.env`
files. The Firebase web configuration used by the dashboard is client-side
configuration; access control is enforced by Firestore rules and it is not a
service-account credential.

If you find a credential or a security issue, do not publish it in an issue.
Contact the repository owner privately and include the affected commit or file
path. Any credential that may have been exposed should be revoked and rotated
before the history is rewritten.
