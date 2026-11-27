export function convertUrl(input: string, codec: (value: string) => string) {
  try {
    return codec(input);
  } catch (error) {
    if (error instanceof URIError) return undefined;
    throw error;
  }
}
