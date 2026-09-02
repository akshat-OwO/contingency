/** Query-string names whose values must not cross a public capture boundary. */
export const SENSITIVE_QUERY_PARAMETER = /(?:token|key|secret|code|password)/iu;

/** Autocomplete tokens browsers use for credentials and payment data. */
export const SENSITIVE_AUTOCOMPLETE =
  /^(?:current-password|new-password|one-time-code|cc-)/iu;

/** Names and accessible metadata commonly used by credential controls. */
export const SENSITIVE_FIELD_METADATA =
  /(?:token|key|secret|code|password|credential|passcode|pin|otp|one[\s_-]?time|cvv|cvc|social[\s_-]?security|ssn)/iu;

export interface SensitiveFieldMetadata {
  readonly ariaLabel?: string | null | undefined;
  readonly autocomplete?: string | null | undefined;
  readonly id?: string | null | undefined;
  readonly inputMode?: string | null | undefined;
  readonly maxLength?: number | null | undefined;
  readonly name?: string | null | undefined;
  readonly type?: string | null | undefined;
}

export const isSensitiveField = ({
  ariaLabel,
  autocomplete,
  id,
  inputMode,
  maxLength,
  name,
  type,
}: SensitiveFieldMetadata): boolean => {
  const metadata = [name, id, ariaLabel].filter(Boolean).join(" ");
  const normalizedAutocomplete = autocomplete?.trim() ?? "";
  const normalizedInputMode = inputMode?.toLowerCase();
  const looksLikeUnlabelledCode =
    (normalizedInputMode === "numeric" || normalizedInputMode === "decimal") &&
    maxLength !== null &&
    maxLength !== undefined &&
    Number.isInteger(maxLength) &&
    maxLength >= 4 &&
    maxLength <= 8;
  return (
    type?.toLowerCase() === "password" ||
    SENSITIVE_AUTOCOMPLETE.test(normalizedAutocomplete) ||
    SENSITIVE_FIELD_METADATA.test(metadata) ||
    looksLikeUnlabelledCode
  );
};

/** Keep navigation useful while removing credentials and secret query values. */
export const sanitizeTeachingUrl = (value: string): string => {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const [name, parameterValue] of url.searchParams) {
      if (parameterValue.length > 0 && SENSITIVE_QUERY_PARAMETER.test(name)) {
        url.searchParams.set(name, "[sensitive]");
      }
    }
    return url.href;
  } catch {
    return "[invalid URL]";
  }
};
