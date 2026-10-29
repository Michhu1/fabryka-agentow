/**
 * The server's password policy (n8n's): 8–64 characters, a digit and an uppercase letter, at most 72
 * UTF-8 bytes. Checked before sending so the form can point at the field; the server decides anyway.
 */
export function meetsPasswordPolicy(password: string): boolean {
  const length = [...password].length;
  return (
    length >= 8 &&
    length <= 64 &&
    new TextEncoder().encode(password).length <= 72 &&
    /\d/.test(password) &&
    /\p{Lu}/u.test(password)
  );
}
