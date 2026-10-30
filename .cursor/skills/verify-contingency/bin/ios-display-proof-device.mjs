// The pinned SDK applies the pose before asking CoreDevice for a hinge sample.
// This host lacks that readback command. Retain only this specific failure and
// require independent active-panel evidence. Every other SDK error still fails.
const hingeReadbackUnavailable = (error) =>
  error?.code === "COMMAND_FAILED" &&
  error.details?.processExitError === true &&
  error.details.exitCode === 64 &&
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- This SDK error boundary validates the message before matching the specific post-dispatch failure.
  typeof error.message === "string" &&
  error.message.startsWith("CoreDevice reported no hinge angle sample:") &&
  Array.isArray(error.details.args) &&
  error.details.args.slice(0, 4).join(" ") ===
    "devicectl device motion hinge-angle";

export const foldWithPanelReadback = async (command, readback) => {
  let result;
  try {
    result = await command();
  } catch (error) {
    if (!hingeReadbackUnavailable(error)) {
      throw error;
    }
    result = {
      hingeAngleConfirmed: false,
      sdkError: { code: error.code, message: error.message },
    };
  }
  return { after: await readback(), result };
};
