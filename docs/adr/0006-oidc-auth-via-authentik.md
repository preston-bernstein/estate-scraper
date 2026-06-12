# OIDC authentication via self-hosted Authentik

The app is multi-user (household now, broader later) and Hunts must be scoped to a person. localStorage-based identity breaks when shared with others and cannot scale beyond the household. The app is an OIDC client against a self-hosted Authentik instance; user identity (sub claim) is the key for Hunt ownership. No user management lives in the app. Authentik is chosen over Keycloak (too heavy) and Authelia (less flexible) as the leading FOSS homelab IdP.
