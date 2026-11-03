/** Markdown keeps short evidence; the original body remains in referenced artifacts. */
export function compactText(text: string | null): string {
  if (text === null) return '';
  return text.length <= 320 ? text : `${text.slice(0, 320)}…（正文见原工件）`;
}
