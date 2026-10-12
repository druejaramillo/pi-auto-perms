const credentialField =
  /^(?:apikey|apitoken|accesstoken|refreshtoken|clientsecret|password|passwd|authorization|cookie|secret|credential|privatekey|token)$/;
const credentialText =
  /authorization\s*[:=]\s*(?:bearer|basic)\s+(?!\$|<)[a-z0-9._~+/-]+|\bsk-(?:proj-)?[a-z0-9_-]{20,}|[?&](?:api[_-]?key|access_token|token|signature)=(?!\$|<)[^\s&'"]+|--(?:api-key|token|password|secret)[=\s]+(?!\$|<)[^\s'"]+/i;
const environmentReference =
  /^(?:Bearer\s+|Basic\s+)?\$(?:[a-zA-Z_][a-zA-Z0-9_]*|\{[a-zA-Z_][a-zA-Z0-9_]*\})$/i;

/** Detect obvious inline credentials; this is a conservative guard, not complete secret discovery. */
export function containsInlinePermissionCredentials(value: unknown): boolean {
  if (typeof value === "string") return credentialText.test(value);
  if (Array.isArray(value)) return value.some(containsInlinePermissionCredentials);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([key, child]) => {
      const normalized = key.toLowerCase().replace(/[_-]/g, "");
      if (
        credentialField.test(normalized) &&
        child !== "" &&
        child !== null &&
        child !== undefined
      ) {
        if (typeof child !== "string" || !environmentReference.test(child)) return true;
      }
      return containsInlinePermissionCredentials(child);
    });
  }
  return false;
}
