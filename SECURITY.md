# Security policy

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's private reporting instead: the repository's **Security** tab → **Report a vulnerability**. Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a reply when it's been looked at; fixes ship on `main` and are noted in the commit history.

Reports about a specific deployment (someone's live CRM) go to whoever runs that deployment, not this repo.

## How the app is secured

[docs/SECURITY.md](docs/SECURITY.md) describes authentication, sessions, files, email, and what keeps a public repo safe to deploy.
