/** Query-string names whose values must not cross a public capture boundary. */
export const SENSITIVE_QUERY_PARAMETER = /(?:token|key|secret|code|password)/iu;

/** Autocomplete tokens browsers use for credentials and payment data. */
export const SENSITIVE_AUTOCOMPLETE =
  /^(?:current-password|new-password|one-time-code|cc-)/iu;

/** Phrases whose presence identifies credential-control metadata. */
export const SENSITIVE_FIELD_PHRASES = [
  "token",
  "secret",
  "password",
  "credential",
  "passcode",
  "otp",
  "cvv",
  "cvc",
  "ssn",
  "api key",
  "api-key",
  "api_key",
  "apikey",
  "auth code",
  "auth-code",
  "auth_code",
  "authcode",
  "authorization code",
  "authorization-code",
  "authorization_code",
  "authorizationcode",
  "client secret",
  "client-secret",
  "client_secret",
  "clientsecret",
  "one time",
  "one-time",
  "one_time",
  "onetime",
  "private key",
  "private-key",
  "private_key",
  "privatekey",
  "social security",
  "social-security",
  "social_security",
  "socialsecurity",
] as const;

export const SENSITIVE_FIELD_METADATA = new RegExp(
  SENSITIVE_FIELD_PHRASES.join("|"),
  "iu"
);

/** Short names are sensitive only when the whole field name is the match. */
export const SENSITIVE_EXACT_FIELD_NAMES = ["code", "key", "pin"] as const;

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
  const metadataFields = [name, id, ariaLabel].flatMap((value) =>
    value === null || value === undefined ? [] : [value.trim().toLowerCase()]
  );
  const metadata = metadataFields.join(" ");
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
    metadataFields.some((value) =>
      SENSITIVE_EXACT_FIELD_NAMES.some((exactName) => exactName === value)
    ) ||
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
