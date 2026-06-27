import { UserManager, WebStorageStateStore } from "oidc-client-ts";

export const userManager = import.meta.env.VITE_OIDC_AUTHORITY
  ? new UserManager({
      authority: import.meta.env.VITE_OIDC_AUTHORITY as string,
      client_id: import.meta.env.VITE_OIDC_CLIENT_ID as string,
      redirect_uri: import.meta.env.VITE_OIDC_REDIRECT_URI as string,
      post_logout_redirect_uri: import.meta.env.VITE_OIDC_POST_LOGOUT_URI as string,
      response_type: "code",
      scope: "openid profile email",
      userStore: new WebStorageStateStore({ store: window.sessionStorage }),
      automaticSilentRenew: false,
      monitorSession: false,
    })
  : null;
