import { homedir, platform } from "node:os";
import path from "node:path";

/**
 * Where Contingency keeps machine-local state: the browser install marker and
 * Run artifacts. Honours `CONTINGENCY_STATE_DIR`, then the platform
 * convention.
 */
export const stateDirectory = (
  operatingSystem: NodeJS.Platform = platform()
): string => {
  const configuredStateDirectory = process.env.CONTINGENCY_STATE_DIR?.trim();
  if (configuredStateDirectory) {
    return configuredStateDirectory;
  }

  if (operatingSystem === "win32") {
    const localApplicationData = process.env.LOCALAPPDATA?.trim();
    return path.join(
      localApplicationData || path.join(homedir(), "AppData", "Local"),
      "contingency"
    );
  }

  const xdgStateHome = process.env.XDG_STATE_HOME?.trim();
  return path.join(
    xdgStateHome || path.join(homedir(), ".local", "state"),
    "contingency"
  );
};

/** One directory per Flow lives under here, keyed by the Flow's identity. */
export const defaultRunsDirectory = (
  operatingSystem: NodeJS.Platform = platform()
): string => path.join(stateDirectory(operatingSystem), "runs");
