/** The sentence a preparation confirmation adds for Clear Starting Data. */
export const clearDataWarning = (app: string) =>
  `This removes ${app}'s sign-in and local data now, again right before you start recording, and before every later Run of this Flow. Other apps and the device are unchanged.`;

/** The question a pending Clear Starting Data decision asks. */
export const clearDataQuestion = (app: string, device: string) =>
  `Clear ${app}'s sign-in and local data on ${device} before Teaching? The app stays installed. It is cleared again right before recording starts, and before every later Run of this Flow.`;
