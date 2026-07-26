/** Join class-name parts, dropping falsy values. */
export function cx(...parts: (string | false | undefined)[]) {
  return parts.filter(Boolean).join(" ")
}
