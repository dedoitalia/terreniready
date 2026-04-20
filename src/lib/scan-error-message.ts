export function formatScanErrorMessage(error: unknown) {
  const rawMessage =
    error instanceof Error
      ? error.message
      : "Impossibile completare la scansione.";

  if (
    rawMessage.includes("responded with 429") ||
    rawMessage.toLowerCase().includes("rate limit")
  ) {
    return "Le sorgenti geospaziali pubbliche sono temporaneamente sature. Riprova tra 1-2 minuti.";
  }

  return rawMessage;
}
