// Where each role lands after sign-in. One login page serves everyone; the
// DESTINATION is what differs. Lifted out of login-form.tsx so the login
// PAGE (a server component, which now checks for an existing session before
// rendering the form) can route with the same rule the form uses, without
// importing across the client boundary.
export function workspaceForRole(role: string | null | undefined): string {
  return role === "AGENT" ? "/agent" : "/admin";
}
